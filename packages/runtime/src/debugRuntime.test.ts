import { type DebugSettings, emptyProject } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import type { DebugStop } from "./debugRuntime";
import { Simulation } from "./simulation";

export const debugProject = (
  code = `import C from "./Counter.koko";
export default system({query:{with:[C]},onUpdate(e){
const c=e.get(C);
c.n+=1;
c.n+=2;
}});`,
) => ({
  ...emptyProject("debug"),
  kokostates: [
    {
      id: "counter",
      name: "Counter",
      fields: [{ id: "n", name: "n", type: "number", default: 0 }],
    },
  ],
  systems: [{ id: "s", name: "S", code }],
  outputs: [
    {
      id: "out",
      name: "out",
      kind: "item" as const,
      systems: [{ id: "s", enabled: true }],
      keep: [],
    },
  ],
  entities: [
    { id: "e", name: "E", output: "out", parent: null, order: 0, states: { counter: { n: 0 } } },
  ],
});
export const settings = (line = 5): DebugSettings => ({
  enabled: true,
  breakOnError: false,
  watches: [],
  breakpoints: [
    {
      id: "p",
      systemId: "s",
      line,
      enabled: true,
      kind: "breakpoint",
      condition: "",
      expression: "",
      entity: "",
    },
  ],
});

describe("待てるフレーム", () => {
  it("終了の例外を利用者がcatchしても、以後の値とログを反映しない", async () => {
    const logs: string[] = [];
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nc.n=1;\ntry {\nc.n=2;\n} catch(err) { c.n=99; world.set(e.id,C,{n:88}); log('ran after dispose'); }\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      onLog: (e) => logs.push(e.message),
      debug: { settings: () => settings(6), onPause: () => sim.dispose() },
    });
    await sim.stepDebug(0.1);
    expect(sim.world.get("e", "counter")?.n).toBe(1);
    expect(logs).toEqual([]);
  });
  it("停止後に呼び出し前の値へ戻しても世界に反映する", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nc.n=1;\nc.n=0;\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: { settings: () => settings(5), onPause: reached },
    });
    try {
      const frame = sim.stepDebug(0.1);
      const stop = await paused;
      expect(sim.world.get("e", "counter")?.n).toBe(1);
      sim.debug?.resume(stop.id);
      await frame;
      expect(sim.world.get("e", "counter")?.n).toBe(0);
    } finally {
      sim.dispose();
    }
  });
  it("停止のための途中表示が再開後の Host API の読み取りを変えない", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nc.n=1;\nc.n=world.get(e.id,C).n;\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: { settings: () => settings(5), onPause: reached },
    });
    try {
      const frame = sim.stepDebug(0.1);
      const stop = await paused;
      expect(sim.world.get("e", "counter")?.n).toBe(1);
      sim.debug?.resume(stop.id);
      await frame;
      expect(sim.world.get("e", "counter")?.n).toBe(0);
    } finally {
      sim.dispose();
    }
  });
  it("空行の条件は次の実行できる行で止まる。古い停止の操作は断る", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\n\nc.n+=2;\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: { settings: () => settings(4), onPause: reached },
    });
    try {
      const frame = sim.stepDebug(0.1);
      const stop = await paused;
      expect(stop.line).toBe(5);
      expect(sim.debug?.resume("old-stop")).toBe(false);
      expect(sim.debug?.stop?.id).toBe(stop.id);
      sim.debug?.resume(stop.id);
      await frame;
      expect(sim.world.get("e", "counter")?.n).toBe(2);
    } finally {
      sim.dispose();
    }
  });
  it("文の途中の状態で止まり、続けると同じ呼び出しの残りを実行する", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const sim = await Simulation.create(debugProject(), "out", {
      realm: "r",
      debug: { settings: () => settings(), onPause: reached },
    });
    try {
      expect(sim.systemStatus()[0]?.error).toBeNull();
      const frame = sim.stepDebug(0.1);
      const stop = await paused;
      expect(stop.line).toBe(5);
      expect(sim.world.get("e", "counter")?.n).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(sim.debug?.resume(stop.id)).toBe(true);
      await frame;
      expect(sim.world.get("e", "counter")?.n).toBe(3);
    } finally {
      sim.dispose();
    }
  });
  it("停止中でも破棄でき、実行中のハンドルを残さない", async () => {
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const sim = await Simulation.create(debugProject(), "out", {
      realm: "r",
      debug: { settings: () => settings(), onPause: reached },
    });
    const frame = sim.stepDebug(0.1);
    await paused;
    sim.dispose();
    await frame;
    expect(sim.debug?.stop).toBeNull();
    expect(sim.world.get("e", "counter")?.n).toBe(1);
  });
  it("通常の再生も同じ最終値になる", async () => {
    const sim = await Simulation.create(debugProject(), "out", { realm: "r" });
    try {
      sim.step(0.1);
      expect(sim.world.get("e", "counter")?.n).toBe(3);
    } finally {
      sim.dispose();
    }
  });
});
