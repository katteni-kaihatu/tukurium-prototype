import { describe, expect, it } from "vitest";
import { rangeInSource, stripTypes } from "./typescriptStrip";

describe("stripTypes", () => {
  it("型を消しても行の数を変えない", () => {
    const ts = [
      "interface Cfg { speed: number }",
      "type V = [number, number, number];",
      "const cfg: Cfg = { speed: 2 };",
      "let x = <number>1;",
      "const y = x as number;",
      "export default system({});",
    ].join("\n");
    const r = stripTypes(ts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.javascript.split("\n")).toHaveLength(6);
    expect(r.javascript).toContain("const cfg = { speed: 2 };");
    expect(r.javascript).not.toMatch(/interface|: Cfg|as number|<number>/);
  });

  it("書き方の誤りは、その行を返す", () => {
    const r = stripTypes("const a = 1;\nconst b: = 2;");
    expect(r).toMatchObject({ ok: false, line: 2 });
  });
});

describe("rangeInSource", () => {
  it("型を消した JavaScript の範囲を、元のコードの同じ行の同じ文字列に戻す", () => {
    const ts = 'const a: number = 1; import G from "./G.koko";';
    const r = stripTypes(ts);
    if (!r.ok) throw new Error("strip");
    const at = r.javascript.indexOf('"./G.koko"');
    const range = rangeInSource(r.javascript, ts, [at, at + '"./G.koko"'.length]);
    expect(range && ts.slice(range[0], range[1])).toBe('"./G.koko"');
  });
});
