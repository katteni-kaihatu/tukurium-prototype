import type { Vec3 } from "@tukurium/eks";
import {
  BUILTIN,
  emptyProject,
  gunAndTargetSample,
  type ProjectSnapshot,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

const fire = (direction: Vec3, action = "fire") => ({
  action,
  phase: "down" as const,
  origin: [0, 1.5, 0] as Vec3,
  direction,
  player: "p1",
});

describe("Simulation：銃と的のサンプル", () => {
  it("撃つと弾が減り、当たった的の hp が減り、倒れてから復活する", async () => {
    const logs: LogEntry[] = [];
    sim = await Simulation.create(gunAndTargetSample(), "out_range", {
      realm: "repo1",
      onLog: (l) => logs.push(l),
    });
    expect(sim.systemStatus().every((s) => s.enabled && !s.error)).toBe(true);
    const target = () => sim?.world.get("ent_target2", "ks_target");
    const gun = () => sim?.world.get("ent_gun", "ks_gun");

    sim.input(fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(gun()?.f_ammo).toBe(11);
    expect(target()?.f_hp).toBe(2);
    expect(sim.world.get("ent_target2", BUILTIN.Mesh)?.color).toBe("#fdd046");

    // クールダウン中は撃てない
    sim.input(fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(gun()?.f_ammo).toBe(11);

    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 15; t++) sim.step(1 / 60);
      sim.input(fire([0, 0, -1]));
      sim.step(1 / 60);
    }
    expect(target()?.f_hp).toBe(0);
    expect(sim.world.get("ent_target2", BUILTIN.Mesh)?.color).toBe("#8a8792");

    // 2 秒後に復活
    for (let t = 0; t < 130; t++) sim.step(1 / 60);
    expect(target()?.f_hp).toBe(3);
    // 他の的には当たっていない
    expect(sim.world.get("ent_target1", "ks_target")?.f_hp).toBe(3);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("外れた弾は何にも当たらない。リロードで弾が戻る", async () => {
    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "repo1" });
    sim.input(fire([0, 1, 0]));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(11);
    expect(
      sim.world.query({ with: ["ks_target"] }).map((e) => sim?.world.get(e, "ks_target")?.f_hp),
    ).toEqual([3, 3, 3]);
    sim.input(fire([0, 0, 0], "reload"));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(12);
  });
});

describe("Simulation：ホストの引き継ぎ", () => {
  it("別の Simulation に状態を移しても、続きから動く", async () => {
    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "a" });
    sim.input(fire([0, 0, -1]));
    sim.step(1 / 60);
    const snap = sim.world.snapshot();
    const names = Object.fromEntries(
      sim.world.entityIds().map((id) => [id, sim?.nameOf(id) ?? id]),
    );
    const time = sim.time;
    sim.dispose();

    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "b" });
    sim.restore(snap, names, time);
    expect(sim.world.get("ent_target2", "ks_target")?.f_hp).toBe(2);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(11);
    expect(sim.time).toBeCloseTo(1 / 60);
    // 引き継いだあとも撃てて、当たる（物理ワールドは作り直される）
    for (let t = 0; t < 15; t++) sim.step(1 / 60);
    sim.input(fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(sim.world.get("ent_target2", "ks_target")?.f_hp).toBe(1);
    expect(sim.nameOf("ent_target2")).toBe("的2");
  });
});

function project(code: string, extra: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  const p = emptyProject("t");
  p.kokostates = [
    { id: "ks_c", name: "Counter", fields: [{ id: "n", name: "n", type: "number", default: 0 }] },
  ];
  p.systems = [{ id: "sys_a", name: "A", code }];
  p.outputs = [
    { id: "out", name: "t", kind: "item", systems: [{ id: "sys_a", enabled: true }], keep: [] },
  ];
  p.entities = [
    { id: "e1", name: "e1", parent: null, output: "out", order: 0, states: { ks_c: { n: 0 } } },
  ];
  return { ...p, ...extra };
}

describe("Simulation：System の扱い", () => {
  it("Query に存在しない KokoState を書くと、その System だけ止まる", async () => {
    const p = project(`export default system({ query: { with: ["Nope"] }, onUpdate() {} });`);
    p.systems.push({
      id: "sys_b",
      name: "B",
      code: `export default system({ query: { with: ["Counter"] }, onUpdate(e) { e.Counter.n += 1; } });`,
    });
    p.outputs[0]?.systems.push({ id: "sys_b", enabled: true });
    sim = await Simulation.create(p, "out", { realm: "r" });
    sim.step(0.1);
    expect(sim.systemStatus().find((s) => s.id === "sys_a")?.error).toMatch(/Nope/);
    expect(sim.world.get("e1", "ks_c")?.n).toBe(1);
  });

  it("実行中に例外を出した System と、無限ループの System は止まり、ほかは動き続ける", async () => {
    const p = project(
      `export default system({ query: { with: ["Counter"] }, onUpdate() { throw new Error("boom"); } });`,
    );
    p.systems.push(
      {
        id: "sys_loop",
        name: "Loop",
        code: `export default system({ query: { with: ["Counter"] }, onUpdate() { for(;;){} } });`,
      },
      {
        id: "sys_ok",
        name: "Ok",
        code: `export default system({ query: { with: ["Counter"] }, onUpdate(e) { e.Counter.n += 1; } });`,
      },
    );
    p.outputs[0]?.systems.push({ id: "sys_loop", enabled: true }, { id: "sys_ok", enabled: true });
    sim = await Simulation.create(p, "out", { realm: "r", timeLimitMs: 20 });
    sim.step(0.1);
    sim.step(0.1);
    const status = Object.fromEntries(sim.systemStatus().map((s) => [s.id, s]));
    expect(status.sys_a?.enabled).toBe(false);
    expect(status.sys_a?.error).toMatch(/boom/);
    expect(status.sys_a?.line).toBe(1);
    expect(status.sys_loop?.error).toMatch(/時間制限/);
    expect(sim.world.get("e1", "ks_c")?.n).toBe(2);
  });

  it("型の合わない値の書き込みは無視する", async () => {
    sim = await Simulation.create(
      project(
        `export default system({ query: { with: ["Counter"] }, onUpdate(e) { e.Counter.n = "x"; } });`,
      ),
      "out",
      { realm: "r" },
    );
    sim.step(0.1);
    expect(sim.world.get("e1", "ks_c")?.n).toBe(0);
  });

  it("spawn / destroy / find / get / set が使える", async () => {
    sim = await Simulation.create(
      project(`export default system({
        query: { with: ["Counter"] },
        onUpdate(e) {
          if (e.Counter.n === 0) {
            const id = world.spawn({ name: "child", states: { Counter: { n: 41 } } });
            world.set(id, "Counter", { n: world.get(id, "Counter").n + 1 });
          } else if (e.Counter.n === 1) {
            world.destroy(world.find("child"));
          }
          e.Counter.n += 1;
        },
      });`),
      "out",
      { realm: "r" },
    );
    sim.step(0.1);
    const child = sim.world.entityIds().find((id) => id !== "e1");
    expect(child && sim.world.get(child, "ks_c")?.n).toBe(42);
    sim.step(0.1);
    expect(sim.world.entityIds()).toEqual(["e1"]);
  });

  it("動く剛体は重力で落ち、床にぶつかると onCollision が呼ばれる", async () => {
    const p = project(
      `export default system({ query: { with: ["Counter"] }, onCollision(e, ev) { if (ev.started) e.Counter.n += 1; } });`,
    );
    p.entities = [
      {
        id: "ball",
        name: "ball",
        parent: null,
        output: "out",
        order: 0,
        states: {
          ks_c: { n: 0 },
          [BUILTIN.Transform]: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: {
            shape: "sphere",
            size: [0.5, 0.5, 0.5],
            material: null,
            color: "#ffffff",
          },
          [BUILTIN.Collider]: { sensor: false },
          [BUILTIN.RigidBody]: { type: "dynamic", linvel: [0, 0, 0] },
        },
      },
      {
        id: "floor",
        name: "floor",
        parent: null,
        output: "out",
        order: 1,
        states: {
          [BUILTIN.Transform]: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: { shape: "box", size: [10, 0.2, 10], material: null, color: "#ffffff" },
          [BUILTIN.Collider]: { sensor: false },
        },
      },
    ];
    sim = await Simulation.create(p, "out", { realm: "r" });
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    const pos = sim.world.get("ball", BUILTIN.Transform)?.position as Vec3 | undefined;
    const y = pos?.[1] ?? Number.NaN;
    expect(y).toBeLessThan(0.5);
    expect(y).toBeGreaterThan(0.2);
    expect(sim.world.get("ball", "ks_c")?.n).toBeGreaterThanOrEqual(1);
  });
});
