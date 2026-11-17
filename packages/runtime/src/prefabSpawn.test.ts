import { BUILTIN, gunAndTargetSample, type ProjectSnapshot } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, PART_RUNTIME_ENTITY_LIMIT, Simulation } from "./simulation";

/**
 * 実行中にプレハブのインスタンスを作る・消す（`Prefab.spawn`・`Prefab.destroy`。ADR 0082）。
 */
let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

/**
 * 銃と的のサンプルに、Bullet のプレハブ（いちばん上と、子「先」が Target を持つ）を足し、Bullet を import する
 * System を一つだけ動かす。本文は、初めに回った Entity で一度だけ動く。Other は、import していないプレハブ。
 * パラメータ：Hp（必須。いちばん上の hp）・TipHp（子の hp）・Position（いちばん上の Transform の位置）。
 */
async function run(body: string, steps = 1) {
  const snap: ProjectSnapshot = gunAndTargetSample();
  const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const prefab = (id: string, name: string, params = {}) => ({
    id,
    name,
    root: `${id}_root`,
    systems: [],
    keep: [],
    params,
  });
  snap.prefabs = [
    prefab("pf_bullet", "Bullet", {
      a: { name: "Hp", entity: "", koko: "ks_target", field: "f_hp", required: true, order: 0 },
      b: {
        name: "TipHp",
        entity: "tip",
        koko: "ks_target",
        field: "f_hp",
        required: false,
        order: 1,
      },
      c: {
        name: "Position",
        entity: "",
        koko: BUILTIN.Transform,
        field: "position",
        required: false,
        order: 2,
      },
    }),
    prefab("pf_other", "Other"),
  ];
  snap.prefabEntities = [
    {
      id: "pf_bullet_root",
      name: "弾",
      prefab: "pf_bullet",
      parent: null,
      order: 0,
      states: { [BUILTIN.Transform]: transform, ks_target: { f_hp: 5, f_maxHp: 9 } },
    },
    {
      id: "tip",
      name: "先",
      prefab: "pf_bullet",
      parent: "pf_bullet_root",
      order: 0,
      states: { [BUILTIN.Transform]: transform, ks_target: { f_hp: 1, f_maxHp: 1 } },
    },
    {
      id: "pf_other_root",
      name: "別",
      prefab: "pf_other",
      parent: null,
      order: 0,
      states: { [BUILTIN.Transform]: transform },
    },
  ];
  snap.systems.push({
    id: "sys_t",
    name: "T",
    code: [
      'import Bullet from "/Bullet.prefab";',
      'import Target from "/Target.koko";',
      "let done = false;",
      "let calls = 0;",
      "export default system({",
      "  query: { with: [Target] },",
      `  onUpdate(e) {\ncalls++;\nif (done) return;\ndone = true;\n${body}\n  },`,
      "});",
    ].join("\n"),
  });
  const out = snap.outputs.find((o) => o.id === "out_range");
  if (!out) throw new Error("out_range がありません");
  out.systems = [{ id: "sys_t", enabled: true }];
  const before = snap.entities.filter((e) => e.states.ks_target).length;
  const logs: LogEntry[] = [];
  sim = await Simulation.create(snap, "out_range", {
    realm: "repo1",
    onLog: (l) => logs.push(l),
    timeLimitMs: 5000,
  });
  for (let i = 0; i < steps; i++) sim.step(1 / 60);
  const status = sim.systemStatus()[0];
  expect(status?.error ?? null).toBe(null);
  const world = sim.world;
  const spawned = world.entityIds().filter((id) => id.startsWith("rt:"));
  return {
    logs: logs.filter((l) => l.level === "log").map((l) => l.message),
    warnings: (status?.warnings ?? []).map((w) => w.code),
    spawned,
    before,
    hp: (id: string) => world.get(id, "ks_target")?.f_hp,
    world,
  };
}

describe("Prefab.spawn", () => {
  it("パラメータを渡して作ると、渡した値で作られ、渡さなかったものはプレハブの値になる", async () => {
    const r = await run("log(String(Prefab.spawn(Bullet, { Hp: 20 })));");
    const root = r.logs[0] ?? "";
    expect(root).toMatch(/^rt:/);
    expect(r.spawned.sort()).toEqual([root, `${root}/tip`]);
    expect(r.hp(root)).toBe(20);
    expect(r.world.get(root, "ks_target")?.f_maxHp).toBe(9);
    expect(r.hp(`${root}/tip`)).toBe(1);
    // 親は配置の空間のいちばん上。子は、作ったいちばん上の下。名前は、プレハブの中の Entity の名前
    expect(r.world.parentOf(`${root}/tip`)).toBe(root);
    expect(r.world.parentOf(root)).toBe(
      r.world.parentOf(r.world.query({ with: ["ks_gun"] })[0] ?? ""),
    );
    expect(sim?.nameOf(`${root}/tip`)).toBe("先");
    expect(r.warnings).toEqual([]);
  });

  it("子の Entity のフィールドと、いちばん上の Transform も、パラメータで決められる", async () => {
    const r = await run(
      "log(String(Prefab.spawn(Bullet, { Hp: 1, TipHp: 7, Position: [1, 2, 3] })));",
    );
    const root = r.logs[0] ?? "";
    expect(r.hp(`${root}/tip`)).toBe(7);
    expect(r.world.get(root, BUILTIN.Transform)?.position).toEqual([1, 2, 3]);
  });

  it("作った Entity は、同じ呼び出しの中で、その System に渡される", async () => {
    const r = await run("Prefab.spawn(Bullet, { Hp: 1 }); log('作った');");
    // 的の数 ＋ 作った二つ（いちばん上と、子）
    expect(r.world.query({ with: ["ks_target"] })).toHaveLength(r.before + 2);
    const calls = await run("Prefab.spawn(Bullet, { Hp: 1 });");
    expect(calls.spawned).toHaveLength(2);
  });

  it("型の合わない値・ないパラメータ・足りない必須のパラメータは使わず、注意として出す（作りはする）", async () => {
    const r = await run('log(String(Prefab.spawn(Bullet, { Hp: "多い", Nai: 1 })));');
    const root = r.logs[0] ?? "";
    expect(r.hp(root)).toBe(5);
    expect(r.warnings.sort()).toEqual(["prefab-param-type", "prefab-param-unknown"]);
    const missing = await run("log(String(Prefab.spawn(Bullet, {})));");
    expect(missing.spawned).toHaveLength(2);
    expect(missing.warnings).toEqual(["prefab-param-missing"]);
  });

  it("依存でたどれないプレハブは、ID の文字を渡しても作れない", async () => {
    const r = await run(
      'log(String(Prefab.spawn("pf_other", {})) + ":" + String(Prefab.spawn("nai")));',
    );
    expect(r.logs).toEqual(["undefined:undefined"]);
    expect(r.spawned).toEqual([]);
    expect(r.warnings).toEqual(["prefab-not-reachable"]);
  });

  it("配置ごとの数の上限を超えると undefined を返し、world.spawn も作らない。消すと、また作れる", async () => {
    const perInstance = 2;
    const max = Math.floor(PART_RUNTIME_ENTITY_LIMIT / perInstance);
    const r = await run(
      [
        "const made = [];",
        `for (let i = 0; i < ${max + 5}; i++) { const b = Prefab.spawn(Bullet, { Hp: 1 }); if (b) made.push(b); }`,
        "const extra = world.spawn({ name: 'x' });",
        "Prefab.destroy(made[0]);",
        "const again = Prefab.spawn(Bullet, { Hp: 1 });",
        "log(made.length + ':' + String(extra) + ':' + (again ? 'できた' : 'できない'));",
      ].join("\n"),
    );
    expect(r.logs).toEqual([`${max}:null:できた`]);
    expect(r.spawned).toHaveLength(PART_RUNTIME_ENTITY_LIMIT);
    expect(r.warnings).toContain("spawn-limit");
  });
});

describe("Prefab.destroy", () => {
  it("作ったインスタンスを、中の Entity ごと消す", async () => {
    const r = await run(
      "const b = Prefab.spawn(Bullet, { Hp: 1 }); log(String(b && Prefab.destroy(b)));",
    );
    expect(r.logs).toEqual(["true"]);
    expect(r.spawned).toEqual([]);
  });

  it("制作データに置いた Entity と、インスタンスの中の Entity は消さない", async () => {
    const r = await run(
      [
        "const b = Prefab.spawn(Bullet, { Hp: 1 });",
        "log(String(Prefab.destroy(e.id)) + ':' + String(Prefab.destroy(b + '/tip')));",
      ].join("\n"),
    );
    expect(r.logs).toEqual(["false:false"]);
    expect(r.spawned).toHaveLength(2);
    expect(r.world.query({ with: ["ks_target"] })).toHaveLength(r.before + 2);
    expect(r.warnings).toEqual(["prefab-destroy-denied"]);
  });

  it("world.destroy で消したインスタンスは、もう Prefab.destroy では消せない（記録から外れている）", async () => {
    const r = await run(
      [
        "const b = Prefab.spawn(Bullet, { Hp: 1 });",
        "world.destroy(b);",
        "log(String(Prefab.destroy(b)));",
      ].join("\n"),
    );
    expect(r.logs).toEqual(["false"]);
    expect(r.spawned).toEqual([]);
  });
});
