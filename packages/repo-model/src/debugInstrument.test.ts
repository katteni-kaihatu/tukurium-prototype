import { describe, expect, it } from "vitest";
import { instrumentDebug } from "./debugInstrument";

describe("デバッグ用の書き換え", () => {
  it("引数の既定値にある関数にも外側の引数を渡す", () => {
    const samples: unknown[] = [];
    const bridge = {
      enter: () => ({}),
      leave: () => {},
      error: () => {},
      read: (read: () => unknown) => {
        try {
          return read();
        } catch {
          return undefined;
        }
      },
      point: (_frame: unknown, _line: number, read: () => [string, unknown, boolean][]) =>
        samples.push(read()),
    };
    const compiled = instrumentDebug("function f(x=3,cb=()=>{return x}){return cb()} f()");
    Function("globalThis", compiled.javascript)({ __debugBridge: bridge });
    expect(samples.at(-1)).toContainEqual(["x", 3, true]);
  });

  it("for の開始位置は、ループの外側の変数の書き込み可否を示す", () => {
    let variables: unknown;
    const bridge = {
      enter: () => ({}),
      leave: () => {},
      error: () => {},
      read: (read: () => unknown) => {
        try {
          return read();
        } catch {
          return undefined;
        }
      },
      point: (_frame: unknown, _line: number, read: () => unknown) => {
        variables = read();
      },
    };
    const compiled = instrumentDebug("function f(){const x=3;for(let x=0;x<1;x++) {}} f()");
    Function("globalThis", compiled.javascript)({ __debugBridge: bridge });
    expect(variables).toContainEqual(["x", 3, false]);
  });
  it.each([
    ["function f(){var g=1; function g(){} return g} f()", 1],
    ["function f(){function g(){return 1} function g(){return 2} return g()} f()", 2],
    ["function f(){var {g}={g:4}; function g(){} return g} f()", 4],
    ["function f(cb=()=>1){return cb()} f()", 1],
  ])("関数宣言と引数の動作を保つ: %s", (source, expected) => {
    let entries = 0;
    const bridge = {
      enter: () => {
        entries++;
        return {};
      },
      leave: () => {},
      error: () => {},
      point: () => {},
      read: () => undefined,
    };
    const result = instrumentDebug(source);
    const actual = Function(
      "globalThis",
      `return eval(${JSON.stringify(result.javascript)});`,
    )({ __debugBridge: bridge });
    expect(actual).toBe(expected);
    if (source.includes("cb=")) expect(entries).toBe(2);
    expect(result.javascript.split("\n")).toHaveLength(source.split("\n").length);
  });
  it.each(["name", "value"])("書き込み用引数は利用者の %s を隠さない", (name) => {
    const target: { result?: number; __debugBridge?: unknown } = {};
    target.__debugBridge = {
      enter: () => ({}),
      leave: () => {},
      error: () => {},
      read: (read: () => unknown) => {
        try {
          return read();
        } catch {
          return undefined;
        }
      },
      point: (
        _frame: unknown,
        line: number,
        _read: unknown,
        write: (name: string, value: unknown) => void,
      ) => {
        if (line === 2) write(name, 10);
      },
    };
    const compiled = instrumentDebug(
      `function f(){ let ${name}=3;\nreturn ${name};}\nglobalThis.result=f();`,
    );
    Function("globalThis", compiled.javascript)(target);
    expect(target.result).toBe(10);
  });

  it("改行を保ち、内側と外側の変数を読み書きする", () => {
    const source = `let outer = 3;
function sum(input) {
  let local = input;
  function inner() {
    local += 2;
    return local + outer;
  }
  return inner();
}
globalThis.result = sum(1);`;
    const result = instrumentDebug(source);
    expect(result.javascript.split("\n")).toHaveLength(source.split("\n").length);
    const stack: { read?: () => [string, unknown, boolean][] }[] = [];
    const samples: unknown[] = [];
    const target: { result?: number; __debugBridge?: unknown } = {};
    target.__debugBridge = {
      enter: () => {
        const f = {};
        stack.push(f);
        return f;
      },
      leave: () => stack.pop(),
      error: () => {},
      read: (read: () => unknown) => {
        try {
          return read();
        } catch {
          return undefined;
        }
      },
      point: (
        frame: (typeof stack)[number],
        line: number,
        read: () => [string, unknown, boolean][],
        write: (name: string, value: unknown) => void,
      ) => {
        frame.read = read;
        if (line === 6) {
          samples.push(
            stack.map((f) =>
              Object.fromEntries((f.read?.() ?? []).map(([name, value]) => [name, value])),
            ),
          );
          write("local", 10);
        }
      },
    };
    // このテスト内の既知のソースだけを実行する。利用者のコードは QuickJS に閉じ込める。
    Function("globalThis", result.javascript)(target);
    expect(target.result).toBe(13);
    expect(samples).toMatchObject([
      [
        { input: 1, local: 3 },
        { local: 3, outer: 3 },
      ],
    ]);
    expect(stack).toHaveLength(0);
  });

  it.each([
    "const f = x => x + 1;",
    "const f = x => (x + 1);",
    "const f = x => ({ x });",
    "const f = x => ((x + 1));",
    "const f = x => /* x => y */ (x + 1);",
    "function f(x) { if(x) return 1; else return 2; }",
    "function f() { for(let x = 0; x < 2; x++) log(x); }",
    "function f() { 'use strict'; let x=1; return x; }",
    "function f() { 'use strict'\n let x=1; return x; }",
    "function f() { again: for(let i=0;i<2;i++) { continue again; } }",
    "const f = ({a}, ...b) => { let x = a; return b; };",
  ])("構文と行数を保つ: %s", (source) => {
    const result = instrumentDebug(source);
    expect(() => Function(result.javascript)).not.toThrow();
    expect(result.javascript.split("\n")).toHaveLength(source.split("\n").length);
  });
});
