import {
  compileSystem,
  type Diagnostic,
  type DiagnosticView,
  inferCapabilities,
  makeDiagnostic,
  type PackageDependency,
  type PackageResolution,
  type ProjectDoc,
  ResourcePathIndex,
} from "@tukurium/repo-model";
import type { SystemStatus } from "@tukurium/runtime";
import { ScriptError, ScriptSandbox } from "@tukurium/script";
import { resolvePackages } from "./packages";

/**
 * スクリプトの問題（「問題」の欄・エディタ・Resources に出す）。
 * 中身は汎用の Diagnostic（ADR 0010）で、対象は System、場所はスクリプトの行。
 */
export type Problem = DiagnosticView;

/** 編集中の確認（構文・読み込み・Query） */
export const SCRIPT_PROVIDER = "script";
/** 実行して止まった System */
export const RUNTIME_PROVIDER = "runtime";

/** スクリプトの何行目か（分かるときだけ） */
export function scriptLine(d: Diagnostic): number | null {
  return d.location?.kind === "script" ? d.location.line : null;
}

/**
 * エラーの出入りを追う（純粋関数）。新しく current になったエラーの指紋を appeared に返す。
 * stale の間も一覧に残っているエラーは「知っている」ままにし、確かめ直しで
 * current に戻っただけでは appeared にしない。消えてから出直したものは appeared にする。
 * 問題パネルをエラーで自動で開く判定（useOpenProblemsOnError）が使う。
 */
export function trackErrorPrints(
  known: ReadonlySet<string>,
  items: readonly DiagnosticView[],
): { appeared: string[]; known: Set<string> } {
  const present = new Set(items.filter((d) => d.severity === "error").map((d) => d.fingerprint));
  const appeared = [
    ...new Set(
      items
        .filter((d) => d.severity === "error" && d.freshness === "current")
        .map((d) => d.fingerprint),
    ),
  ].filter((fp) => !known.has(fp));
  const next = new Set([...known].filter((fp) => present.has(fp)));
  for (const fp of appeared) next.add(fp);
  return { appeared, known: next };
}

function scriptDiagnostic(
  systemId: string,
  code: string,
  message: string,
  line: number | null,
  phase: "authoring" | "runtime",
  symbol?: string,
): Diagnostic {
  return makeDiagnostic({
    code,
    severity: "error",
    phase,
    provider: phase === "runtime" ? RUNTIME_PROVIDER : SCRIPT_PROVIDER,
    subject: { kind: "system", id: systemId },
    location: { kind: "script", line, ...(symbol === undefined ? {} : { symbol }) },
    related: [],
    message,
  });
}

const CHECK_REALM = "__check";
let sandbox: Promise<ScriptSandbox> | null = null;

/**
 * 編集中の確認：Play しなくても分かる問題（構文の誤り・export default がない・
 * Query の KokoState が見つからない）を、実行用とは別のサンドボックスで読み込んで調べる。
 * 実行はしない（読み込みだけ）ので、副作用はない。
 */
export async function checkScripts(
  project: ProjectDoc,
  systemIds?: readonly string[],
  loadPackages: (
    deps: readonly PackageDependency[],
  ) => Promise<Map<string, PackageResolution>> = resolvePackages,
): Promise<Diagnostic[]> {
  sandbox ??= ScriptSandbox.create({ loadTimeLimitMs: 1000 });
  const sb = await sandbox;
  // 依存の中身（`@別名/...` の import の解決に使う。ADR 0015）
  const deps = project.dependencies();
  const packages = deps.length > 0 ? await loadPackages(deps) : new Map();
  const registry = project.registry();
  const problems: Diagnostic[] = [];
  const only = systemIds ? new Set(systemIds) : null;
  let index: ResourcePathIndex | null = null;
  for (const def of project.systems()) {
    if (only && !only.has(def.id)) continue;
    const code = project.code(def.id)?.toString() ?? "";
    // import を安定 ID に結び付ける（見つからない・曖昧な import はその行の問題にする）
    if (code.includes("import")) {
      index ??= ResourcePathIndex.fromSnapshot(project.snapshot());
    }
    const compiled = index
      ? compileSystem(def.id, code, index, packages)
      : { ok: true, javascript: code, diagnostics: [], bindings: [] };
    if (!compiled.ok) {
      problems.push(...compiled.diagnostics);
      continue;
    }
    // ライブラリから取り込んだ KokoState（Query には ID で届く。ADR 0015）
    const fromPackages = new Set(
      compiled.bindings.filter((b) => b.package !== undefined).map((b) => b.resourceId),
    );
    // 要る権限を読み取れない使い方（world[name]() など）は注意にする（セッションでは拒まれる。ADR 0012）
    problems.push(...inferCapabilities(def.id, code).diagnostics);
    try {
      const meta = sb.loadSystem(def.id, compiled.javascript, CHECK_REALM);
      for (const name of [...meta.query.with, ...meta.query.without]) {
        // import した KokoState は ID で届く。移行の間の書き方は名前で届く（ADR 0010）
        if (fromPackages.has(name) || registry.get(name) || registry.idOf(name)) continue;
        const ambiguous = registry.isAmbiguous(name);
        problems.push(
          scriptDiagnostic(
            def.id,
            ambiguous ? "query-kokostate-ambiguous" : "query-kokostate-missing",
            ambiguous
              ? `Query の KokoState「${name}」は同じ名前が複数あります（import で読み込んでください）`
              : `Query の KokoState「${name}」が見つかりません`,
            lineOf(code, name),
            "authoring",
            name,
          ),
        );
      }
    } catch (e) {
      problems.push(
        scriptDiagnostic(
          def.id,
          "script-load",
          e instanceof Error ? e.message : String(e),
          e instanceof ScriptError ? e.line : null,
          "authoring",
        ),
      );
    }
  }
  // メモリを使いすぎるスクリプトでサンドボックスが壊れたら、次は作り直す
  if (sb.broken) {
    sb.dispose();
    sandbox = null;
  } else {
    sb.disposeRealm(CHECK_REALM);
  }
  return problems;
}

/** 実行中の System の状態から、止まった System を問題にする */
export function runDiagnostics(status: readonly SystemStatus[]): Diagnostic[] {
  const stopped = status
    .filter((s) => s.error)
    .map((s) => scriptDiagnostic(s.id, "script-stopped", s.error ?? "", s.line, "runtime"));
  // 止まるほどではない注意（拒否など）。回数があれば添える
  const warnings = status.flatMap((s) =>
    (s.warnings ?? []).map((w) =>
      makeDiagnostic({
        code: w.code,
        severity: "warning",
        phase: "runtime",
        provider: RUNTIME_PROVIDER,
        subject: { kind: "system", id: s.id },
        location: { kind: "script", line: null, symbol: w.code },
        related: [],
        message: w.count > 1 ? `${w.message}（${w.count} 回）` : w.message,
      }),
    ),
  );
  return [...stopped, ...warnings];
}

/** 実行の問題を足し合わせる（同じ問題は新しいほうに差し替える） */
export function mergeRun(prev: readonly Diagnostic[], next: readonly Diagnostic[]): Diagnostic[] {
  const out = new Map(prev.map((d) => [d.fingerprint, d]));
  for (const d of next) out.set(d.fingerprint, d);
  return [...out.values()];
}

/** 文字列が最初に出てくる行（Query の名前の場所を指すため） */
function lineOf(code: string, text: string): number | null {
  const i = code.indexOf(`"${text}"`);
  return i < 0 ? null : code.slice(0, i).split("\n").length;
}
