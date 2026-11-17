import { BUILTIN, gunAndTargetSample, type ProjectSnapshot } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { Simulation } from "./simulation";

/**
 * プレハブの System（ADR 0082）：配置のときに先に読み込み、そのプレハブのインスタンスを実行中に作って、
 * 残っている間だけ動かす。
 */
let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/**
 * 銃と的のサンプルに、Bullet のプレハブ（System「Fly」を持つ。Fly は、Target の hp に毎回 100 を足す）と、
 * Bullet を中に置いた Gun2 のプレハブを足す。アウトプットには、どちらのインスタンスも置かない。
 * アウトプットの System「T」は、step ごとの本文（bodies の順）を、初めに回った Entity で動かす。
 */
function project(bodies: string[], flyEnabled = true): ProjectSnapshot {
  const snap = gunAndTargetSample();
  snap.prefabs = [
    {
      id: "pf_bullet",
      name: "Bullet",
      root: "b_root",
      systems: [{ id: "sys_fly", enabled: flyEnabled }],
      keep: [],
    },
    { id: "pf_gun2", name: "Gun2", root: "g_root", systems: [], keep: [] },
  ];
  snap.prefabEntities = [
    {
      id: "b_root",
      name: "弾",
      prefab: "pf_bullet",
      parent: null,
      order: 0,
      states: { [BUILTIN.Transform]: transform },
    },
    {
      id: "g_root",
      name: "銃2",
      prefab: "pf_gun2",
      parent: null,
      order: 0,
      states: { [BUILTIN.Transform]: transform },
    },
    {
      id: "g_bullet",
      name: "中の弾",
      prefab: "pf_gun2",
      parent: "g_root",
      order: 0,
      states: { [BUILTIN.Transform]: transform },
      instanceOf: { prefab: "pf_bullet" },
    },
  ];
  snap.systems.push(
    {
      id: "sys_fly",
      name: "Fly",
      code: [
        'import Target from "/Target.koko";',
        "export default system({ query: { with: [Target] }, onUpdate(e) { e.get(Target).hp += 100; } });",
      ].join("\n"),
    },
    {
      id: "sys_t",
      name: "T",
      code: [
        'import Bullet from "/Bullet.prefab";',
        'import Gun2 from "/Gun2.prefab";',
        'import Target from "/Target.koko";',
        "let step = 0;",
        "let made;",
        "let first;",
        "export default system({",
        "  query: { with: [Target] },",
        "  onUpdate(e) {",
        "    first ??= e.id;",
        "    if (e.id !== first) return;",
        "    step++;",
        ...bodies.map((b, i) => `    if (step === ${i + 1}) { ${b} }`),
        "  },",
        "});",
      ].join("\n"),
    },
  );
  const out = snap.outputs.find((o) => o.id === "out_range");
  if (!out) throw new Error("out_range がありません");
  out.systems = [{ id: "sys_t", enabled: true }];
  return snap;
}

/** 的の hp の合計（初めは 3 が三つで 9） */
const total = (prefix = "") => {
  const world = sim?.world;
  if (!world) return 0;
  return world
    .query({ with: [prefix ? `${prefix}:ks_target` : "ks_target"] })
    .reduce(
      (sum, id) => sum + Number(world.get(id, prefix ? `${prefix}:ks_target` : "ks_target")?.f_hp),
      0,
    );
};

describe("プレハブの System", () => {
  it("アウトプットにインスタンスがなくても、作ったインスタンスがある間だけ動く", async () => {
    sim = await Simulation.create(
      project(["", "made = Prefab.spawn(Bullet);", "", "Prefab.destroy(made);", ""]),
      "out_range",
      { realm: "repo1" },
    );
    expect(sim.systemStatus().map((s) => [s.name, s.error ?? null])).toEqual([
      ["T", null],
      ["Fly", null],
    ]);
    // 1：インスタンスがないので、Fly は、アウトプットの的では動かない
    sim.step(1 / 60);
    expect(total()).toBe(9);
    // 2：作った。Fly は T のあとの System なので、同じフレームから動く（的 3 つに 100 ずつ）
    sim.step(1 / 60);
    expect(total()).toBe(309);
    // 3：残っている間は、動き続ける
    sim.step(1 / 60);
    expect(total()).toBe(609);
    // 4：消した。同じフレームから、動かない
    sim.step(1 / 60);
    expect(total()).toBe(609);
    sim.step(1 / 60);
    expect(total()).toBe(609);
  });

  it("作ったプレハブの中に置いた、入れ子のプレハブの System も動く", async () => {
    sim = await Simulation.create(project(["made = Prefab.spawn(Gun2);", ""]), "out_range", {
      realm: "repo1",
    });
    sim.step(1 / 60);
    expect(total()).toBe(309);
  });

  it("world.destroy で消しても、止まる", async () => {
    sim = await Simulation.create(
      project(["made = Prefab.spawn(Bullet);", "world.destroy(made);", ""]),
      "out_range",
      { realm: "repo1" },
    );
    sim.step(1 / 60);
    expect(total()).toBe(309);
    sim.step(1 / 60);
    sim.step(1 / 60);
    expect(total()).toBe(309);
  });

  it("プレハブで「切」にした System は、作っても動かない", async () => {
    sim = await Simulation.create(
      project(["made = Prefab.spawn(Bullet);", ""], false),
      "out_range",
      {
        realm: "repo1",
      },
    );
    sim.step(1 / 60);
    sim.step(1 / 60);
    expect(total()).toBe(9);
  });

  it("リセットすると、作ったインスタンスが消え、System も止まる", async () => {
    sim = await Simulation.createSession();
    sim.addPart({
      id: "a",
      realm: "repo1",
      outputId: "out_range",
      snapshot: project(["made = Prefab.spawn(Bullet);", "", ""]),
      position: [0, 0, 0],
      yaw: 0,
    });
    sim.step(1 / 60);
    const before = sim.world.entityIds().filter((id) => id.startsWith("rt:")).length;
    expect(before).toBe(1);
    sim.resetPart("a");
    expect(sim.world.entityIds().filter((id) => id.startsWith("rt:"))).toEqual([]);
  });

  it("ホストが替わっても、作ったインスタンスの記録を引き継ぐ：プレハブの System が動き続け、Prefab.destroy で消せる", async () => {
    // インスタンスがなければ作り、次の回で消す（引き継いだ側は、スクリプトの変数を持たないので、名前で探す。
    // 作ったインスタンスのいちばん上の名前は、プレハブの名前）
    const bodies = [
      "if (!world.find('Bullet')) Prefab.spawn(Bullet);",
      "log(String(Prefab.destroy(world.find('Bullet'))));",
      "",
    ];
    const first = await Simulation.create(project(bodies), "out_range", { realm: "repo1" });
    first.step(1 / 60);
    const handoff = {
      world: first.world.snapshot(),
      names: Object.fromEntries(first.world.entityIds().map((id) => [id, first.nameOf(id)])),
      time: first.time,
      partEntities: first.partEntitiesSnapshot(),
      spawned: first.spawnedSnapshot(),
    };
    first.dispose();
    expect(Object.values(handoff.spawned)).toEqual(["pf_bullet"]);

    const logs: string[] = [];
    sim = await Simulation.create(project(bodies), "out_range", {
      realm: "repo1",
      onLog: (l) => logs.push(l.message),
    });
    sim.restore(handoff.world, handoff.names, handoff.time, handoff.partEntities, handoff.spawned);
    expect(total()).toBe(309);
    // 引き継いだ側の 1 回目：弾があるので作らない。プレハブの System は動く
    sim.step(1 / 60);
    expect(total()).toBe(609);
    // 2 回目：引き継いだインスタンスを、Prefab.destroy で消せる
    sim.step(1 / 60);
    expect(logs).toEqual(["true"]);
    expect(sim.spawnedSnapshot()).toEqual({});
    expect(total()).toBe(609);
  });

  it("記録を引き継がないと、作ったインスタンスは、ただの Entity になる（System は動かず、Prefab.destroy で消せない）", async () => {
    const bodies = ["if (!world.find('Bullet')) Prefab.spawn(Bullet);", ""];
    const first = await Simulation.create(project(bodies), "out_range", { realm: "repo1" });
    first.step(1 / 60);
    const world = first.world.snapshot();
    const names = Object.fromEntries(first.world.entityIds().map((id) => [id, first.nameOf(id)]));
    const partEntities = first.partEntitiesSnapshot();
    first.dispose();
    sim = await Simulation.create(project(bodies), "out_range", { realm: "repo1" });
    sim.restore(world, names, 0, partEntities);
    sim.step(1 / 60);
    expect(total()).toBe(309);
  });

  it("適用すると、作ったインスタンスが消え、新しい版のプレハブと System で作り直せる", async () => {
    sim = await Simulation.createSession();
    const part = {
      id: "a",
      realm: "repo1",
      outputId: "out_range",
      position: [0, 0, 0] as [number, number, number],
      yaw: 0,
    };
    sim.addPart({ ...part, snapshot: project(["Prefab.spawn(Bullet);", ""]) });
    sim.step(1 / 60);
    expect(Object.keys(sim.spawnedSnapshot())).toHaveLength(1);
    // 新しい版：Fly が足す数を変え、T は、Bullet を中に持つ Gun2 を作る
    const next = project(["Prefab.spawn(Gun2);", ""]);
    const fly = next.systems.find((s) => s.id === "sys_fly");
    if (fly) fly.code = fly.code.replace("+= 100", "+= 1000");
    sim.applyPart("repo1", "out_range", next);
    expect(sim.spawnedSnapshot()).toEqual({});
    expect(sim.world.entityIds().filter((id) => id.startsWith("rt:"))).toEqual([]);
    sim.step(1 / 60);
    expect(Object.values(sim.spawnedSnapshot())).toEqual(["pf_gun2"]);
    const world = sim.world;
    const hps = world
      .entityIds()
      .flatMap((id) =>
        world
          .statesOf(id)
          .flatMap((k) => (k.endsWith("ks_target") ? [world.get(id, k)?.f_hp] : [])),
      );
    expect(hps).toEqual([1003, 1003, 1003]);
  });

  it("デバッグ実行でも、作ったインスタンスでプレハブの System が動き、巻き戻しの点に記録が入る", async () => {
    sim = await Simulation.create(project(["made = Prefab.spawn(Bullet);", ""]), "out_range", {
      realm: "repo1",
      debug: {
        settings: () => ({ enabled: true, breakOnError: false, watches: [], breakpoints: [] }),
        onPause: () => {},
      },
    });
    await sim.stepDebug(1 / 60);
    expect(sim.systemStatus().map((s) => s.error ?? null)).toEqual([null, null]);
    expect(total()).toBe(309);
    // 巻き戻しの点は、フレームの初めの状態。次のフレームの初めには、作ったインスタンスの記録が入っている
    await sim.stepDebug(1 / 60);
    expect(Object.values(sim.debugCheckpoint()?.spawned ?? {})).toEqual(["pf_bullet"]);
  });

  it("セッションで同じアウトプットを二つ置き、片方で作っても、もう片方の Entity では動かない", async () => {
    sim = await Simulation.createSession();
    // a では作り、b では何もしない（スクリプトは同じ。配置の ID で分ける）
    const snapshot = project(["if (e.id.startsWith('a/')) made = Prefab.spawn(Bullet);", ""]);
    for (const id of ["a", "b"])
      sim.addPart({
        id,
        realm: "repo1",
        outputId: "out_range",
        snapshot,
        position: [id === "a" ? 0 : 50, 0, 0],
        yaw: 0,
      });
    sim.step(1 / 60);
    const world = sim.world;
    const hp = (part: string) =>
      world
        .entityIds()
        .filter((id) => id.startsWith(`${part}/`))
        .flatMap((id) =>
          world
            .statesOf(id)
            .flatMap((k) => (k.endsWith("ks_target") ? [world.get(id, k)?.f_hp] : [])),
        );
    expect(hp("a")).toEqual([103, 103, 103]);
    expect(hp("b")).toEqual([3, 3, 3]);
  });
});
