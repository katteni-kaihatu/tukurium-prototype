import {
  type Diagnostic,
  type DiagnosticView,
  makeDiagnostic,
  type ProjectDoc,
} from "@tukurium/repo-model";
import type { SystemStatus } from "@tukurium/runtime";
import { ScriptError, ScriptSandbox } from "@tukurium/script";

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
export async function checkScripts(project: ProjectDoc): Promise<Diagnostic[]> {
  sandbox ??= ScriptSandbox.create({ loadTimeLimitMs: 1000 });
  const sb = await sandbox;
  const registry = project.registry();
  const problems: Diagnostic[] = [];
  for (const def of project.systems()) {
    const code = project.code(def.id)?.toString() ?? "";
    try {
      const meta = sb.loadSystem(def.id, code, CHECK_REALM);
      for (const name of [...meta.query.with, ...meta.query.without]) {
        if (!registry.idOf(name)) {
          problems.push(
            scriptDiagnostic(
              def.id,
              "query-kokostate-missing",
              `Query の KokoState「${name}」が見つかりません`,
              lineOf(code, name),
              "authoring",
              name,
            ),
          );
        }
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
  return status
    .filter((s) => s.error)
    .map((s) => scriptDiagnostic(s.id, "script-stopped", s.error ?? "", s.line, "runtime"));
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
