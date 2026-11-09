import { transform } from "sucrase";

/**
 * スクリプト（TypeScript）の型を消して JavaScript にする（ADR 0058）。
 * sucrase は型を消しても行の数を変えないので、実行時の誤りの行がそのまま元のコードの行になる。
 * 型の確かめはしない（別に TypeScript の Language Service で行う）。
 */
export type StripResult =
  | { ok: true; javascript: string }
  | { ok: false; message: string; line: number | null };

export function stripTypes(source: string): StripResult {
  try {
    const { code } = transform(source, {
      transforms: ["typescript"],
      // 新しい JavaScript の書き方はそのまま残す（QuickJS が読める）
      disableESTransforms: true,
      // 型にしか使っていない import も残す（KokoState の import を結び付けるため）
      keepUnusedImports: true,
    });
    return { ok: true, javascript: code };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const loc = (e as { loc?: { line?: unknown } } | null)?.loc;
    const line =
      loc && typeof loc.line === "number"
        ? loc.line
        : Number(/\((\d+):\d+\)/.exec(message)?.[1] ?? Number.NaN);
    return {
      ok: false,
      message: message.replace(/\s*\(\d+:\d+\)\s*$/, ""),
      line: Number.isFinite(line) ? line : null,
    };
  }
}

/** 文字の位置 → 何行目か（1 から） */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** 何行目か → その行の始めの文字の位置 */
function lineStart(text: string, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const i = text.indexOf("\n", at);
    if (i < 0) return text.length;
    at = i + 1;
  }
  return at;
}

/**
 * 型を消した JavaScript の中の範囲を、元のコード（TypeScript）の範囲に戻す。
 * 型を消しても行は変わらないので、同じ行の中で同じ文字列を探す（import のパスの文字列に使う）。
 * 見つからなければ null。
 */
export function rangeInSource(
  javascript: string,
  source: string,
  range: readonly [number, number],
): [number, number] | null {
  const text = javascript.slice(range[0], range[1]);
  const line = lineAt(javascript, range[0]);
  const start = lineStart(source, line);
  const end = source.indexOf("\n", start);
  const i = source.slice(start, end < 0 ? undefined : end).indexOf(text);
  return i < 0 ? null : [start + i, start + i + text.length];
}
