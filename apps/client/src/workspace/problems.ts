import type { ProjectDoc } from "@tukurium/repo-model";
import type { SystemStatus } from "@tukurium/runtime";
import { ScriptError, ScriptSandbox } from "@tukurium/script";

/** スクリプトの問題（「問題」の欄・エディタ・Resources に出す） */
export interface Problem {
  systemId: string;
  message: string;
  /** スクリプトの何行目か（分かるときだけ） */
  line: number | null;
  /** check：編集中の確認（構文・読み込み）、run：実行して止まった */
  source: "check" | "run";
}

const CHECK_REALM = "__check";
let sandbox: Promise<ScriptSandbox> | null = null;

/**
 * 編集中の確認：Play しなくても分かる問題（構文の誤り・export default がない・
 * Query の KokoState が見つからない）を、実行用とは別のサンドボックスで読み込んで調べる。
 * 実行はしない（読み込みだけ）ので、副作用はない。
 */
export async function checkScripts(project: ProjectDoc): Promise<Problem[]> {
  sandbox ??= ScriptSandbox.create({ loadTimeLimitMs: 1000 });
  const sb = await sandbox;
  const registry = project.registry();
  const problems: Problem[] = [];
  for (const def of project.systems()) {
    const code = project.code(def.id)?.toString() ?? "";
    try {
      const meta = sb.loadSystem(def.id, code, CHECK_REALM);
      for (const name of [...meta.query.with, ...meta.query.without]) {
        if (!registry.idOf(name)) {
          problems.push({
            systemId: def.id,
            message: `Query の KokoState「${name}」が見つかりません`,
            line: lineOf(code, name),
            source: "check",
          });
        }
      }
    } catch (e) {
      problems.push({
        systemId: def.id,
        message: e instanceof Error ? e.message : String(e),
        line: e instanceof ScriptError ? e.line : null,
        source: "check",
      });
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
export function runProblems(status: readonly SystemStatus[]): Problem[] {
  return status
    .filter((s) => s.error)
    .map((s) => ({ systemId: s.id, message: s.error ?? "", line: s.line, source: "run" }));
}

/** 表示用：同じ System・同じ内容の重複を除き、実行時の問題を先に並べる */
export function mergeProblems(run: readonly Problem[], check: readonly Problem[]): Problem[] {
  const out: Problem[] = [];
  for (const p of [...run, ...check]) {
    if (!out.some((q) => q.systemId === p.systemId && q.message === p.message)) out.push(p);
  }
  return out;
}

/** 文字列が最初に出てくる行（Query の名前の場所を指すため） */
function lineOf(code: string, text: string): number | null {
  const i = code.indexOf(`"${text}"`);
  return i < 0 ? null : code.slice(0, i).split("\n").length;
}
