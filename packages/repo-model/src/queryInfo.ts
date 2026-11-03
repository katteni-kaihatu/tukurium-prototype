/**
 * System のコードから Query（With / Without の KokoState 名）を読み取る。表示用の簡易な読み取りで、
 * 実際に使われる Query は実行時にスクリプトを評価して決まる（ランタイムの SystemMeta）。
 */
export function parseQuery(code: string): { with: string[]; without: string[] } {
  const list = (key: string): string[] => {
    const m = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(code);
    if (!m?.[1]) return [];
    return [...m[1].matchAll(/["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g)].map((x) => x[1] as string);
  };
  return { with: list("with"), without: list("without") };
}
