import { describe, expect, it } from "vitest";
import { compileDebugExpression } from "./debugExpression";

describe("読み取りだけのデバッグ式", () => {
  it.each([
    "n=2",
    "n++",
    "delete a.x",
    "fn()",
    "new X()",
    "a.constructor('return 1')()",
    "n; x",
    "true); n++; (false",
  ])("副作用のある式を拒む: %s", (source) => {
    expect(() => compileDebugExpression(source)).toThrow();
  });
  it("フィールド参照と計算を受け付ける", () => {
    expect(compileDebugExpression('e.id === "a" && n > 2')).toHaveLength(4);
  });
});
