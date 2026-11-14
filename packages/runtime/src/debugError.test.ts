import { type DebugSettings, emptyProject } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import type { DebugStop } from "./debugRuntime";
import { Simulation } from "./simulation";

async function run(body: string, patch: Partial<DebugSettings> = {}) {
  const stops: DebugStop[] = [];
  const config: DebugSettings = {
    enabled: true,
    breakOnError: true,
    breakpoints: [],
    watches: [],
    ...patch,
  };
  const sim = await Simulation.create(
    {
      ...emptyProject("error"),
      systems: [{ id: "s", name: "S", code: `export default system({onUpdate(e){\n${body}\n}});` }],
      outputs: [
        { id: "out", name: "Out", kind: "item", systems: [{ id: "s", enabled: true }], keep: [] },
      ],
      entities: [{ id: "e", name: "E", output: "out", order: 0, parent: null, states: {} }],
    },
    "out",
    {
      realm: "r",
      debug: {
        settings: () => config,
        onPause: (s) => {
          stops.push(s);
          sim.debug?.resume(s.id);
        },
      },
    },
  );
  try {
    await sim.stepDebug(0.1);
    return { stops, status: sim.systemStatus()[0] };
  } finally {
    sim.dispose();
  }
}
describe("エラーでの一時停止", () => {
  it("例外のtoStringを停止のために呼ばない", async () => {
    const result = await run("let n=0;try{throw {toString(){n++;return 'boom';}};}catch{}");
    expect(result.stops[0]?.frames.at(-1)?.variables.find((v) => v.name === "n")?.value).toBe(0);
  });
  it("多行の引数内で先に変えた値と実際のエラー行を示す", async () => {
    const result = await run("let n=0;\nMath.max(\n(n=1),\nnull.missing\n);");
    expect(result.stops[0]?.line).toBe(5);
  });
  it("catchの中の暗黙の例外もfinallyより先に止める", async () => {
    const result = await run("let n=0;try{throw 1;}catch{const {x}=null;}finally{n=2;}");
    expect(result.stops).toHaveLength(2);
    expect(result.stops[1]?.frames.at(-1)?.variables.find((v) => v.name === "n")?.value).toBe(0);
  });
  it.each(["const {x}=null;", "for(const x of null){}"])(
    "暗黙の処理の例外もfinallyの前に止める: %s",
    async (code) => {
      const result = await run(`let n=0;\ntry {\n${code}\n} finally {\nn=2;\n}`);
      expect(result.stops[0]?.line).toBe(4);
      expect(result.stops[0]?.frames.at(-1)?.variables.find((v) => v.name === "n")?.value).toBe(0);
    },
  );
  it("finally内で別の例外を捕捉しても伝播中の例外を再報告しない", async () => {
    const result = await run(
      "function boom(){throw 'boom';}\ntry {boom();}finally{try{throw 'ignore';}catch{}}",
    );
    expect(result.stops.map((s) => s.message)).toEqual(["boom", "ignore"]);
  });
  it("finallyの前に発生時の行と値で止まる", async () => {
    const result = await run("let n=0;\ntry {\nn++,null.missing;\n} finally {\nn=2;\n}");
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]?.line).toBe(4);
    expect(result.stops[0]?.frames.at(-1)?.variables.find((v) => v.name === "n")?.value).toBe(1);
  });
  it("finallyを通る同じ例外を重複して止めない", async () => {
    const result = await run(
      "function inner(){throw Error('boom');}\ntry {inner();} finally {let cleanup=1;}",
    );
    expect(result.stops).toHaveLength(1);
  });
  it("例外Proxyの表示が元の例外を置き換えない", async () => {
    const result = await run(
      "throw new Proxy(Error('original'),{getOwnPropertyDescriptor(){throw Error('trap');}});",
    );
    expect(result.stops[0]?.message).toContain("例外が発生しました");
    expect(result.status?.error).toContain("original");
  });
  it("同じ式で先に変えた値を読み、続けると通常のエラー処理へ戻る", async () => {
    const result = await run("let n=0;\nn++, null.missing;");
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]?.reason).toBe("実行中のエラー");
    expect(result.stops[0]?.line).toBe(3);
    expect(result.stops[0]?.frames.at(-1)?.variables.find((v) => v.name === "n")?.value).toBe(1);
    expect(result.status?.enabled).toBe(false);
    expect(result.status?.error).toBeTruthy();
  });
  it("呼び出し元へ伝わる同じ例外を重複して止めない", async () => {
    const result = await run("function inner(){let n=2;throw 'boom';}\ninner();");
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]?.frames).toHaveLength(2);
    expect(result.stops[0]?.message).toBe("boom");
  });
  it("無効化・Entity・式で絞り込める", async () => {
    for (const patch of [
      { breakOnError: false },
      { errorEntity: "another" },
      { errorCondition: "n > 1" },
    ]) {
      const result = await run("let n=1; throw Error('boom');", patch);
      expect(result.stops).toEqual([]);
      expect(result.status?.enabled).toBe(false);
    }
  });
  it("catch後の別のthrowは同じ値でも再び止まる", async () => {
    const result = await run("function inner(){throw 'boom';}\ntry{inner();}catch{}\ninner();");
    expect(result.stops).toHaveLength(2);
  });
});
