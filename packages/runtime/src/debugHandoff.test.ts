import { decodeValue } from "@tukurium/eks";
import { type DebugSettings, emptyProject } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import type { DebugStop } from "./debugRuntime";
import { Simulation } from "./simulation";

const project = {
  ...emptyProject("handoff"),
  kokostates: [
    { id: "c", name: "C", fields: [{ id: "n", name: "n", type: "number", default: 0 }] },
  ],
  systems: [
    {
      id: "s",
      name: "S",
      code: "import C from './C.koko';\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nc.n++;\nc.n++;\n}});",
    },
  ],
  outputs: [
    {
      id: "out",
      name: "Out",
      kind: "item" as const,
      systems: [{ id: "s", enabled: true }],
      keep: [],
    },
  ],
  entities: [
    { id: "e", name: "E", output: "out", parent: null, order: 0, states: { c: { n: 0 } } },
  ],
};
const settings: DebugSettings = {
  enabled: true,
  breakOnError: false,
  watches: [],
  breakpoints: [
    {
      id: "p",
      systemId: "s",
      line: 5,
      enabled: true,
      kind: "breakpoint",
      condition: "",
      expression: "",
      entity: "",
    },
  ],
};
async function create(code = project.systems[0]?.code ?? "") {
  const queue: DebugStop[] = [];
  const waits: ((stop: DebugStop) => void)[] = [];
  const sim = await Simulation.create(
    { ...project, systems: [{ id: "s", name: "S", code }] },
    "out",
    {
      realm: "r",
      debug: {
        settings: () => settings,
        onPause: (s) => {
          const w = waits.shift();
          if (w) w(s);
          else queue.push(s);
        },
      },
    },
  );
  return {
    sim,
    next: () => {
      const s = queue.shift();
      return s ? Promise.resolve(s) : new Promise<DebugStop>((r) => waits.push(r));
    },
  };
}
describe("停止中のホスト交代", () => {
  it("フレーム開始時の注意と回数を写し取り復元する", async () => {
    const code = (project.systems[0]?.code ?? "").replace("c.n++;", "bag.count(C);");
    const first = await create(code);
    let running = first.sim.stepDebug(0.1);
    const stop = await first.next();
    first.sim.debug?.resume(stop.id);
    await running;
    running = first.sim.stepDebug(0.1);
    await first.next();
    const checkpoint = first.sim.debugCheckpoint();
    if (!checkpoint) throw Error("checkpoint missing");
    expect(checkpoint.systems[0]?.warnings[0]?.count).toBe(1);
    expect(first.sim.systemStatus()[0]?.warnings[0]?.count).toBe(2);
    const second = await create(code);
    try {
      second.sim.restoreDebugCheckpoint(checkpoint);
      expect(second.sim.systemStatus()[0]?.warnings).toEqual(checkpoint.systems[0]?.warnings);
    } finally {
      second.sim.dispose();
      first.sim.dispose();
      await running;
    }
  });
  it("部分的な世界ではなくフレーム開始時の世界と入力を引き継ぐ", async () => {
    const first = await create();
    first.sim.input({
      action: "fire",
      phase: "down",
      player: "p",
      origin: [0, 0, 0],
      direction: [0, 0, -1],
    });
    const running = first.sim.stepDebug(0.1);
    await first.next();
    expect(first.sim.world.get("e", "c")?.n).toBe(1);
    const checkpoint = first.sim.debugCheckpoint();
    if (!checkpoint) throw Error("checkpoint missing");
    expect(checkpoint.time).toBe(0);
    expect((decodeValue(checkpoint.queues) as { inputs: unknown[] }).inputs).toHaveLength(1);
    first.sim.dispose();
    await running;
    const second = await create();
    try {
      second.sim.restoreDebugCheckpoint(checkpoint);
      second.sim.debug?.holdAfterHandoff();
      const held = await second.next();
      expect(held.reason).toContain("ホスト交代");
      expect(second.sim.world.get("e", "c")?.n).toBe(0);
      second.sim.debug?.resume(held.id, "continue");
      const run = second.sim.stepDebug(0.1);
      const stopped = await second.next();
      expect(second.sim.world.get("e", "c")?.n).toBe(1);
      expect(second.sim.time).toBe(0.1);
      second.sim.debug?.resume(stopped.id);
      await run;
      expect(second.sim.world.get("e", "c")?.n).toBe(2);
    } finally {
      second.sim.dispose();
    }
  });
  it("引き継ぎ直後の次フレーム操作は一フレームを実行する", async () => {
    const { sim, next } = await create();
    sim.debug?.holdAfterHandoff();
    const held = await next();
    sim.debug?.resume(held.id, "frame");
    await sim.stepDebug(0.1);
    expect(sim.time).toBe(0.1);
    const run = sim.stepDebug(0.1);
    const boundary = await next();
    expect(boundary.reason).toBe("次のフレーム");
    expect(sim.time).toBe(0.1);
    sim.dispose();
    await run;
  });
});
