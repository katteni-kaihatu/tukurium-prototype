import type { Vec3 } from "@tukurium/eks";
import {
  BUILTIN,
  emptyProject,
  gunAndTargetSample,
  type ProjectSnapshot,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";
import { inputWithTools } from "./testInput";

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

    inputWithTools(sim, fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(gun()?.f_ammo).toBe(11);
    expect(target()?.f_hp).toBe(2);
    expect(sim.world.get("ent_target2", BUILTIN.Mesh)?.color).toBe("#fdd046");

    // クールダウン中は撃てない
    inputWithTools(sim, fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(gun()?.f_ammo).toBe(11);

    for (let i = 0; i < 2; i++) {
      for (let t = 0; t < 15; t++) sim.step(1 / 60);
      inputWithTools(sim, fire([0, 0, -1]));
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
    inputWithTools(sim, fire([0, 1, 0]));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(11);
    expect(
      sim.world.query({ with: ["ks_target"] }).map((e) => sim?.world.get(e, "ks_target")?.f_hp),
    ).toEqual([3, 3, 3]);
    inputWithTools(sim, fire([0, 0, 0], "reload"));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(12);
  });
});

describe("Simulation：ホストの引き継ぎ", () => {
  it("別の Simulation に状態を移しても、続きから動く", async () => {
    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "a" });
    inputWithTools(sim, fire([0, 0, -1]));
    sim.step(1 / 60);
    const snap = sim.world.snapshot();
    const names = Object.fromEntries(
      sim.world.entityIds().map((id) => [id, sim?.nameOf(id) ?? id]),
    );
    const time = sim.time;
    const ownership = sim.partEntitiesSnapshot();
    sim.dispose();

    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "b" });
    sim.restore(snap, names, time, ownership);
    expect(sim.world.get("ent_target2", "ks_target")?.f_hp).toBe(2);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(11);
    expect(sim.time).toBeCloseTo(1 / 60);
    // 引き継いだあとも撃てて、当たる（物理ワールドは作り直される）
    for (let t = 0; t < 15; t++) sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1]));
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

describe("Simulation：右クリックで持つ（Grabbable）", () => {
  const box = (rotation: Vec3 = [0, 0, 0], rigid = true) => {
    const p = project(`export default system({ query: { with: ["Counter"] }, onUpdate() {} });`);
    p.entities.push({
      id: "box",
      name: "箱",
      parent: null,
      output: "out",
      order: 1,
      states: {
        [BUILTIN.Transform]: { position: [0, 1.5, -3], rotation, scale: [1, 1, 1] },
        [BUILTIN.Mesh]: { shape: "box", size: [0.5, 0.5, 0.5] },
        [BUILTIN.Collider]: {},
        ...(rigid ? { [BUILTIN.RigidBody]: { type: "dynamic" } } : {}),
        [BUILTIN.Grabbable]: { distance: 1 },
      },
    });
    return p;
  };

  it("持った瞬間は位置も角度も変えず、すぐ離せば同じ場所にある", async () => {
    sim = await Simulation.create(box([10, 20, 30], false), "out", { realm: "r" });
    sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    const held = sim.world.get("box", BUILTIN.Grabbable);
    expect(held?.player).toBe("p1");
    const pos = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    const rot = sim.world.get("box", BUILTIN.Transform)?.rotation as Vec3;
    expect(pos[0]).toBeCloseTo(0, 5);
    expect(pos[1]).toBeCloseTo(1.5, 5);
    expect(pos[2]).toBeCloseTo(-3, 5);
    expect(rot[0]).toBeCloseTo(10, 4);
    expect(rot[1]).toBeCloseTo(20, 4);
    expect(rot[2]).toBeCloseTo(30, 4);
    // 同じ視点のまま追従しても、場所は変わらない
    inputWithTools(sim, fire([0, 0, -1], "hold"));
    sim.step(1 / 60);
    const still = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(still[2]).toBeCloseTo(-3, 4);
    // 押したままもう一度 down が来ても、離すまでは持ったまま
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    expect(sim.world.get("box", BUILTIN.Grabbable)?.player).not.toBe("");
    inputWithTools(sim, { ...fire([0, 0, -1], "grab"), phase: "up" });
    sim.step(1 / 60);
    expect(sim.world.get("box", BUILTIN.Grabbable)?.player).toBe("");
    const after = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(after[0]).toBeCloseTo(0, 4);
    expect(after[1]).toBeCloseTo(1.5, 4);
    expect(after[2]).toBeCloseTo(-3, 4);
    // 向きを変えてから離すと、見えていた位置に残る（追従の送信を待たない）
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    inputWithTools(sim, { ...fire([1, 0, 0], "grab"), phase: "up" });
    sim.step(1 / 60);
    const left = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(sim.world.get("box", BUILTIN.Grabbable)?.player).toBe("");
    expect(left[0]).toBeCloseTo(3, 1);
    expect(left[1]).toBeCloseTo(1.5, 1);
    expect(left[2]).toBeCloseTo(0, 1);
  });

  it("持っている間は視点との位置関係を保ち、落ちない。ほかの人は取れない", async () => {
    sim = await Simulation.create(box(), "out", { realm: "r" });
    sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    // 右を向くと、持ったときの「3m 手前」が右へ移る
    inputWithTools(sim, fire([1, 0, 0], "hold"));
    for (let i = 0; i < 30; i++) sim.step(1 / 60);
    const pos = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(pos[0]).toBeCloseTo(3, 1);
    expect(pos[1]).toBeCloseTo(1.5, 1);
    expect(pos[2]).toBeCloseTo(0, 1);
    inputWithTools(sim, { ...fire([1, 0, 0], "grab"), player: "p2" });
    sim.step(1 / 60);
    expect(sim.world.get("box", BUILTIN.Grabbable)?.player).toBe("p1");
    inputWithTools(sim, { ...fire([1, 0, 0], "grab"), phase: "up" });
    for (let i = 0; i < 30; i++) sim.step(1 / 60);
    expect(sim.world.get("box", BUILTIN.Grabbable)?.player).toBe("");
    const dropped = sim.world.get("box", BUILTIN.Transform)?.position as Vec3 | undefined;
    expect(dropped?.[1]).toBeLessThan(1.4);
  });

  it("ホイールで前後に動かし、画面上の位置は保つ", async () => {
    sim = await Simulation.create(box([0, 0, 0], false), "out", { realm: "r" });
    sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    inputWithTools(sim, { ...fire([0, 0, -1], "reach"), pointer: [1, 0] });
    sim.step(1 / 60);
    const far = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(far[0]).toBeCloseTo(0, 2);
    expect(far[1]).toBeCloseTo(1.5, 2);
    expect(far[2]).toBeCloseTo(-4, 2);
    inputWithTools(sim, { ...fire([0, 0, -1], "reach"), pointer: [-1, 0] });
    sim.step(1 / 60);
    const back = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(back[2]).toBeCloseTo(-3, 2);
  });

  it("左クリックで傾きを直し、E の動きで角度が変わる", async () => {
    sim = await Simulation.create(box([30, 40, 25], false), "out", { realm: "r" });
    sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1], "grab"));
    sim.step(1 / 60);
    inputWithTools(sim, fire([0, 0, -1], "align"));
    sim.step(1 / 60);
    const upright = sim.world.get("box", BUILTIN.Transform)?.rotation as Vec3;
    expect(upright[0]).toBeCloseTo(0, 4);
    expect(upright[2]).toBeCloseTo(0, 4);
    expect(Math.abs(upright[1])).toBeGreaterThan(1);
    const y = upright[1];
    inputWithTools(sim, { ...fire([0, 0, -1], "twist"), pointer: [Math.PI / 2, 0] });
    sim.step(1 / 60);
    const turned = sim.world.get("box", BUILTIN.Transform)?.rotation as Vec3;
    expect(turned[1]).not.toBeCloseTo(y, 0);
    const pos = sim.world.get("box", BUILTIN.Transform)?.position as Vec3;
    expect(pos[2]).toBeCloseTo(-3, 4);
  });
});

describe("Simulation：import で書いた System（ADR 0010）", () => {
  /** Gun を States フォルダに、Shoot を Systems フォルダに入れ、Shoot を import で書き直す */
  function importSample(code: string): ProjectSnapshot {
    const snap = gunAndTargetSample();
    snap.folders = [
      { id: "f_states", name: "States", parent: null },
      { id: "f_sys", name: "Systems", parent: null },
    ];
    const gun = snap.kokostates.find((k) => k.name === "Gun");
    if (!gun) throw new Error("Gun がありません");
    snap.placement = { [gun.id]: "f_states", sys_shoot: "f_sys" };
    snap.systems = snap.systems.map((s) => (s.id === "sys_shoot" ? { ...s, code } : s));
    return snap;
  }

  it("import した KokoState で Query を書き、entity.get で値を読み書きできる", async () => {
    sim = await Simulation.create(
      importSample(`import Gun from "../States/Gun.koko";
import Transform from "@builtin/Transform.koko";
export default system({
  query: { with: [Gun, Transform] },
  onInput(e, ev) {
    if (ev.action !== "fire" || ev.phase !== "down") return;
    const gun = e.get(Gun);
    gun.ammo -= 1;
    const t = world.get(e.id, Transform);
    log("pos", t.position.length);
  },
});`),
      "out_range",
      { realm: "repo1" },
    );
    expect(sim.systemStatus().find((s) => s.id === "sys_shoot")).toMatchObject({ error: null });
    inputWithTools(sim, fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(11);
  });

  it("見つからない import は、その行の読み込みエラーにする", async () => {
    sim = await Simulation.create(
      importSample(`export default system({});\nimport Gun from "./Gun.koko";`),
      "out_range",
      { realm: "repo1" },
    );
    expect(sim.systemStatus().find((s) => s.id === "sys_shoot")).toMatchObject({
      error: "KokoState「./Gun.koko」が見つかりません",
      line: 2,
    });
  });
});

describe("Simulation：同じ名前の KokoState を別名で使う（ADR 0010 Phase 5）", () => {
  it("別のフォルダの同じ名前の KokoState を、import の別名で区別して読み書きできる", async () => {
    const snap = emptyProject("p");
    snap.kokostates = [
      {
        id: "ks_pg",
        name: "Gun",
        fields: [{ id: "f_a", name: "ammo", type: "number", default: 5 }],
      },
      {
        id: "ks_eg",
        name: "Gun",
        fields: [{ id: "f_a", name: "ammo", type: "number", default: 9 }],
      },
    ];
    snap.folders = [
      { id: "f_player", name: "Player", parent: null },
      { id: "f_enemy", name: "Enemy", parent: null },
    ];
    snap.placement = { ks_pg: "f_player", ks_eg: "f_enemy" };
    snap.entities = [
      {
        id: "e",
        name: "e",
        parent: null,
        output: "out_main",
        order: 0,
        states: { ks_pg: { f_a: 5 }, ks_eg: { f_a: 9 } },
      },
    ];
    snap.systems = [
      {
        id: "sys",
        name: "Both",
        code: `import PlayerGun from "/Player/Gun.koko";
import EnemyGun from "/Enemy/Gun.koko";
export default system({
  query: { with: [PlayerGun, EnemyGun] },
  onUpdate(e) {
    e.get(PlayerGun).ammo -= 1;
    e.get(EnemyGun).ammo += 1;
    log("legacy", typeof e.Gun);
  },
});`,
      },
    ];
    snap.outputs = snap.outputs.map((o) => ({ ...o, systems: [{ id: "sys", enabled: true }] }));
    const logs: LogEntry[] = [];
    sim = await Simulation.create(snap, "out_main", { realm: "r", onLog: (l) => logs.push(l) });
    expect(sim.systemStatus()[0]).toMatchObject({ error: null });
    sim.step(1 / 60);
    expect(sim.world.get("e", "ks_pg")?.f_a).toBe(4);
    expect(sim.world.get("e", "ks_eg")?.f_a).toBe(10);
    // 名前が一つに決まらないので、名前での入口（e.Gun）はない
    expect(logs.map((l) => l.message)).toContain("legacy undefined");
  });
});

describe("Simulation：Transform は初期値からのずれ", () => {
  const bare = () => {
    const snap = emptyProject("bare");
    snap.entities = [
      {
        id: "root",
        name: "根",
        parent: null,
        output: "out_main",
        order: 0,
        states: { [BUILTIN.Mesh]: { shape: "box" } },
      },
      {
        id: "child",
        name: "子",
        parent: "root",
        output: "out_main",
        order: 1,
        states: { [BUILTIN.Mesh]: { shape: "sphere" } },
      },
    ];
    return snap;
  };

  it("再生の位置が初期値なら、Transform は付かない", async () => {
    sim = await Simulation.create(bare(), "out_main", { realm: "r" });
    expect(sim.world.hasState("root", BUILTIN.Transform)).toBe(false);
    expect(sim.world.hasState("child", BUILTIN.Transform)).toBe(false);
  });

  it("配置の位置は、初期値にそのずれを足したものになる", async () => {
    const withDefault = bare();
    const root = withDefault.entities[0];
    if (!root) throw new Error("root がない");
    root.states = {
      ...root.states,
      [BUILTIN.Transform]: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    sim = await Simulation.createSession();
    sim.addPart({
      id: "a",
      realm: "r",
      outputId: "out_main",
      snapshot: bare(),
      position: [3, 1, -2],
      yaw: 0,
    });
    sim.addPart({
      id: "b",
      realm: "r",
      outputId: "out_main",
      snapshot: withDefault,
      position: [3, 1, -2],
      yaw: 0,
    });
    expect(sim.world.get("a/root", BUILTIN.Transform)?.position).toEqual([3, 1, -2]);
    expect(sim.world.get("a/root", BUILTIN.Transform)?.rotation).toEqual([0, 0, 0]);
    expect(sim.world.get("a/root", BUILTIN.Transform)?.scale).toEqual([1, 1, 1]);
    expect(sim.world.get("b/root", BUILTIN.Transform)?.position).toEqual([3, 1, -2]);
    // 子は親からのずれがないので、Transform は付かない
    expect(sim.world.hasState("a/child", BUILTIN.Transform)).toBe(false);
  });
});

describe("Simulation：装備（EquipmentTool。ADR 0053）", () => {
  /** 再生を始めた位置（+Z 側 6m、目の高さ）から、置いてある銃を見る */
  const lookAtGun = (player: string, action = "use") => {
    const origin: Vec3 = [0, 1.6, 6];
    const to: Vec3 = [0, 1.1, 3.6];
    const d = to.map((v, i) => v - (origin[i] ?? 0));
    const len = Math.hypot(...d);
    return {
      action,
      phase: "down" as const,
      origin,
      direction: d.map((v) => v / len) as Vec3,
      player,
    };
  };

  it("E で見ている道具を右手に装備し、装備した人の入力だけが道具に届く", async () => {
    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "r" });
    const ammo = () => sim?.world.get("ent_gun", "ks_gun")?.f_ammo;
    // 装備する前は、誰が撃っても銃は動かない
    sim.input(fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(ammo()).toBe(12);

    sim.input(lookAtGun("p1"));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", BUILTIN.EquipmentTool)?.player).toBe("p1");
    // 右手（視点からの位置）へ動く
    const at = sim.world.get("ent_gun", BUILTIN.Transform)?.position as Vec3;
    expect(at[2]).toBeGreaterThan(5);

    // ほかの人の fire は届かず、装備した人の fire は届く
    sim.input({ ...fire([0, 0, -1]), player: "p2" });
    sim.step(1 / 60);
    expect(ammo()).toBe(12);
    sim.input(fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(ammo()).toBe(11);

    // ほかの人は、装備されている道具を拾えない
    sim.input(lookAtGun("p2"));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", BUILTIN.EquipmentTool)?.player).toBe("p1");
  });

  it("外すとその場に落とす（置いた位置のまま、誰も装備していない）", async () => {
    sim = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "r" });
    sim.input(lookAtGun("p1"));
    sim.step(1 / 60);
    const inHand = [...((sim.world.get("ent_gun", BUILTIN.Transform)?.position as Vec3) ?? [])];
    sim.input({ ...lookAtGun("p1"), action: "unequip" });
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", BUILTIN.EquipmentTool)?.player).toBe("");
    expect(sim.world.get("ent_gun", BUILTIN.Transform)?.position).toEqual(inHand);
    // 落とした後は、ほかの人が拾える
    sim.input(fire([0, 0, -1]));
    sim.step(1 / 60);
    expect(sim.world.get("ent_gun", "ks_gun")?.f_ammo).toBe(12);
  });
});
