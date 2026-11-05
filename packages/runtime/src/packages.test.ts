import {
  type PackageDependency,
  type PackageManifest,
  type PackageResolution,
  type ProjectSnapshot,
  packageResourceId,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { Simulation } from "./simulation";

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

const dep: PackageDependency = {
  alias: "combat",
  packageId: "w_lib",
  version: 2,
  contentHash: "h",
};
const HEALTH = packageResourceId(dep, "ks_health");

/** ライブラリ：States/Health.koko（hp）を公開している */
const manifest: PackageManifest = {
  format: 1,
  exports: [
    {
      kind: "kokostate",
      id: "ks_health",
      path: "/States/Health.koko",
      definition: {
        id: "ks_health",
        name: "Health",
        fields: [{ id: "f_hp", name: "hp", type: "number", default: 10 }],
      },
    },
  ],
};
const ready: PackageResolution[] = [{ status: "ready", dependency: dep, manifest }];

/** Health を付けた的と、毎フレーム hp を 1 減らす System */
function project(realmTag = "a"): ProjectSnapshot {
  return {
    version: 1,
    name: `p_${realmTag}`,
    kokostates: [],
    systems: [
      {
        id: "sys_drain",
        name: "Drain",
        code: `import Health from "@combat/States/Health.koko";
export default system({ query: { with: [Health] }, onUpdate(e) { e.get(Health).hp -= 1; } });`,
      },
    ],
    materials: [],
    outputs: [
      {
        id: "out",
        name: "的",
        kind: "item",
        systems: [{ id: "sys_drain", enabled: true }],
        keep: [],
      },
    ],
    entities: [
      {
        id: "ent",
        name: "的",
        parent: null,
        output: "out",
        order: 0,
        states: { [HEALTH]: { f_hp: 5 } },
      },
    ],
    dependencies: [dep],
  };
}

describe("依存の KokoState を再生で使う（ADR 0015）", () => {
  it("ワークスペースの再生で、import した依存の KokoState を読み書きできる", async () => {
    sim = await Simulation.create(project(), "out", { realm: "ws", packages: ready });
    expect(sim.systemStatus().map((s) => s.error)).toEqual([null]);
    sim.step(1 / 60);
    expect(sim.world.get("ent", HEALTH)?.f_hp).toBe(4);
  });

  it("依存の中身が届いていなければ、System はその理由で止まる", async () => {
    sim = await Simulation.create(project(), "out", { realm: "ws" });
    expect(sim.systemStatus()[0]?.error).toContain("中身が届いていません");
  });

  it("依存の取得状態を再適用し、共有Systemの全配置の利用者を保つ (#63)", async () => {
    const snapshot = project();
    const output = snapshot.outputs[0];
    const entity = snapshot.entities[0];
    if (!output || !entity) throw new Error("出力またはEntityがありません");
    snapshot.outputs = ["a", "b"].map((id) => ({ ...output, id }));
    snapshot.entities = ["a", "b"].map((id) => ({ ...entity, id, output: id }));
    const placements = [
      ["a1", "a"],
      ["a2", "a"],
      ["b1", "b"],
    ] as const;
    sim = await Simulation.createSession();
    for (const [id, outputId] of placements)
      sim.addPart({ id, outputId, realm: "repoA", snapshot, position: [0, 0, 0], yaw: 0 });
    expect(sim.systemStatus()[0]?.error).toContain("中身が届いていません");

    expect(sim.applyPart("repoA", "a", snapshot, ready).instances).toBe(2);
    expect(sim.systemStatus().map((s) => [s.enabled, s.error])).toEqual([[true, null]]);
    sim.step(1 / 60);
    const health = (id: string, entityId: string) =>
      sim?.world.get(`${id}/${entityId}`, HEALTH)?.f_hp;
    expect([health("a1", "a"), health("a2", "a")]).toEqual([4, 4]);

    sim.applyPart("repoA", "b", snapshot, ready);
    sim.step(1 / 60);
    expect(placements.map(([id, entityId]) => health(id, entityId))).toEqual([3, 3, 4]);

    sim.applyPart("repoA", "a", snapshot, [
      { status: "unavailable", dependency: dep, message: "取得失敗" },
    ]);
    expect(sim.systemStatus()[0]?.error).toContain("取得失敗");
    sim.step(1 / 60);
    expect(health("b1", "b")).toBe(4);
    sim.applyPart("repoA", "a", snapshot, ready);
    sim.step(1 / 60);
    expect(placements.map(([id, entityId]) => health(id, entityId))).toEqual([4, 4, 3]);

    sim.removePart("a1");
    sim.removePart("a2");
    sim.step(1 / 60);
    expect(health("b1", "b")).toBe(2);
  });

  it("lock と違う版の中身は使わない", async () => {
    const other: PackageResolution[] = [
      { status: "ready", dependency: { ...dep, contentHash: "other" }, manifest },
    ];
    sim = await Simulation.create(project(), "out", { realm: "ws", packages: other });
    expect(sim.systemStatus()[0]?.error).toContain("中身が届いていません");
  });

  it("セッションでは、同じライブラリの同じ版の KokoState を、別のリポジトリの配置どうしで共有する", async () => {
    sim = await Simulation.createSession();
    const at = { position: [0, 0, 0] as [number, number, number], yaw: 0 };
    sim.addPart({
      id: "p1",
      realm: "repoA",
      outputId: "out",
      snapshot: project("a"),
      packages: ready,
      ...at,
    });
    sim.addPart({
      id: "p2",
      realm: "repoB",
      outputId: "out",
      snapshot: project("b"),
      packages: ready,
      ...at,
    });
    expect(sim.stateIdOf("p1", HEALTH)).toBe(HEALTH);
    expect(sim.stateIdOf("p2", HEALTH)).toBe(HEALTH);
    sim.step(1 / 60);
    expect(sim.world.get("p1/ent", HEALTH)?.f_hp).toBe(4);
    expect(sim.world.get("p2/ent", HEALTH)?.f_hp).toBe(4);
    // 片方を外しても、もう片方が使っている間は定義を残す
    sim.removePart("p1");
    expect(sim.registry.get(HEALTH)?.name).toBe("Health");
    sim.removePart("p2");
    expect(sim.registry.get(HEALTH)).toBeUndefined();
  });

  it("依存の KokoState は、名前での書き方（移行の間）では引けない", async () => {
    const snap = project();
    const sys = snap.systems[0];
    if (sys) sys.code = `export default system({ query: { with: ["Health"] }, onUpdate() {} });`;
    sim = await Simulation.create(snap, "out", { realm: "ws", packages: ready });
    expect(sim.systemStatus()[0]?.error).toContain("見つかりません");
  });

  it("適用で依存の版を変えると、新しい版の中身で作り直す", async () => {
    sim = await Simulation.createSession();
    const at = { position: [0, 0, 0] as [number, number, number], yaw: 0 };
    sim.addPart({
      id: "p1",
      realm: "repoA",
      outputId: "out",
      snapshot: project(),
      packages: ready,
      ...at,
    });
    const v3 = { ...dep, version: 3 };
    const HEALTH3 = packageResourceId(v3, "ks_health");
    const next = project();
    next.dependencies = [v3];
    const ent = next.entities[0];
    if (ent) ent.states = { [HEALTH3]: { f_hp: 9 } };
    sim.applyPart("repoA", "out", next, [{ status: "ready", dependency: v3, manifest }]);
    expect(sim.registry.get(HEALTH)).toBeUndefined();
    sim.step(1 / 60);
    expect(sim.world.get("p1/ent", HEALTH3)?.f_hp).toBe(8);
  });
});

/** ライブラリの System（Systems/Count.system）。モジュールの変数で数え、hp にその値を入れる */
const COUNT = `import Health from "../States/Health.koko";
let n = 0;
export default system({ query: { with: [Health] }, onUpdate(e) { n += 1; e.get(Health).hp = n; } });`;

function withSystem(code: string, extra: PackageManifest["exports"] = []): PackageResolution[] {
  return [
    {
      status: "ready",
      dependency: dep,
      manifest: {
        format: 1,
        exports: [
          ...manifest.exports,
          ...extra,
          {
            kind: "system",
            id: "sys_count",
            path: "/Systems/Count.system",
            definition: { id: "sys_count", name: "Count", code },
          },
        ],
      },
    },
  ];
}
const COUNT_ID = packageResourceId(dep, "sys_count");

/** 依存の System だけを動かすプロジェクト */
function usesLibrarySystem(tag = "a"): ProjectSnapshot {
  const s = project(tag);
  s.systems = [];
  const out = s.outputs[0];
  if (out) out.systems = [{ id: COUNT_ID, enabled: true }];
  return s;
}

describe("依存の System をアウトプットで使う（ADR 0015）", () => {
  it("ライブラリの中の論理パスで import を解決し、再生で動く。主体はそのライブラリの Package", async () => {
    sim = await Simulation.create(usesLibrarySystem(), "out", {
      realm: "ws",
      packages: withSystem(COUNT),
    });
    expect(sim.systemStatus().map((s) => [s.name, s.error])).toEqual([["@combat/Count", null]]);
    sim.step(1 / 60);
    sim.step(1 / 60);
    expect(sim.world.get("ent", HEALTH)?.f_hp).toBe(2);
    expect(sim.executionContext("main", COUNT_ID)).toMatchObject({
      packageId: "w_lib",
      resolvedVersion: "2",
      contentHash: "h",
      systemId: COUNT_ID,
      placementId: "main",
    });
  });

  it("ライブラリで公開していないものを import した System は、見つからないで止まる", async () => {
    const code = `import Secret from "../States/Secret.koko";\nexport default system({ query: { with: [Secret] }, onUpdate() {} });`;
    sim = await Simulation.create(usesLibrarySystem(), "out", {
      realm: "ws",
      packages: withSystem(code),
    });
    expect(sim.systemStatus()[0]?.error).toContain("見つかりません");
  });

  it("依存の中身が届いていなければ、理由つきで止まる", async () => {
    sim = await Simulation.create(usesLibrarySystem(), "out", { realm: "ws" });
    expect(sim.systemStatus()[0]?.error).toContain("中身が届いていません");
  });

  it("使うプロジェクトが違えば、同じライブラリの System でも VM は別（変数が混ざらない）", async () => {
    sim = await Simulation.createSession();
    const at = { position: [0, 0, 0] as [number, number, number], yaw: 0 };
    const packages = withSystem(COUNT);
    sim.addPart({
      id: "p1",
      realm: "repoA",
      outputId: "out",
      snapshot: usesLibrarySystem("a"),
      packages,
      ...at,
    });
    sim.addPart({
      id: "p2",
      realm: "repoB",
      outputId: "out",
      snapshot: usesLibrarySystem("b"),
      packages,
      ...at,
    });
    expect(sim.systemStatus()).toHaveLength(2);
    sim.step(1 / 60);
    expect(sim.world.get("p1/ent", HEALTH)?.f_hp).toBe(1);
    expect(sim.world.get("p2/ent", HEALTH)?.f_hp).toBe(1);
    sim.removePart("p1");
    sim.removePart("p2");
    expect(sim.systemStatus()).toEqual([]);
  });

  it("ライブラリの System には、使う側の KokoState は見えない（Built-in と依存のものだけ）", async () => {
    sim = await Simulation.createSession();
    const snap = usesLibrarySystem();
    snap.kokostates = [{ id: "ks_secret", name: "Secret", fields: [] }];
    const ent = snap.entities[0];
    if (ent) ent.states.ks_secret = {};
    const code = `import Health from "../States/Health.koko";
export default system({ query: { with: [Health] }, onUpdate(e) { e.get(Health).hp = e.Secret === undefined ? 1 : 2; } });`;
    sim.addPart({
      id: "p1",
      realm: "repoA",
      outputId: "out",
      snapshot: snap,
      packages: withSystem(code),
      position: [0, 0, 0],
      yaw: 0,
    });
    sim.step(1 / 60);
    expect(sim.systemStatus()[0]?.error).toBeNull();
    expect(sim.world.get("p1/ent", HEALTH)?.f_hp).toBe(1);
  });
});

describe("依存の依存（ADR 0015）", () => {
  /** Lib2：Lib1（別名 base）に依存し、Lib1 の Health を減らす System を公開している */
  const lib2Dep: PackageDependency = {
    alias: "arms",
    packageId: "w_lib2",
    version: 1,
    contentHash: "h2",
  };
  const lib2: PackageResolution = {
    status: "ready",
    dependency: lib2Dep,
    manifest: {
      format: 1,
      exports: [
        {
          kind: "system",
          id: "sys_drain",
          path: "/Drain.system",
          definition: {
            id: "sys_drain",
            name: "Drain",
            code: `import Health from "@base/States/Health.koko";
export default system({ query: { with: [Health] }, onUpdate(e) { e.get(Health).hp -= 1; } });`,
          },
        },
      ],
      dependencies: [{ ...dep, alias: "base" }],
    },
  };
  const DRAIN = packageResourceId(lib2Dep, "sys_drain");

  function usesLib2(): ProjectSnapshot {
    const s = project();
    s.systems = [];
    s.dependencies = [dep, lib2Dep];
    const out = s.outputs[0];
    if (out) out.systems = [{ id: DRAIN, enabled: true }];
    return s;
  }

  it("ライブラリの System の @別名 は、そのライブラリの依存で解決する", async () => {
    // pool の Lib1 は、Lib2 の依存としての別名（base）でも、使う側の別名（combat）でもよい（lock で照らす）
    sim = await Simulation.create(usesLib2(), "out", {
      realm: "ws",
      packages: [lib2, ...ready],
    });
    expect(sim.systemStatus().map((s) => [s.name, s.error])).toEqual([["@arms/Drain", null]]);
    sim.step(1 / 60);
    expect(sim.world.get("ent", HEALTH)?.f_hp).toBe(4);
  });

  it("依存の依存が届いていなければ、理由つきで止まる", async () => {
    sim = await Simulation.create(usesLib2(), "out", { realm: "ws", packages: [lib2] });
    expect(sim.systemStatus()[0]?.error).toContain("中身が届いていません");
  });

  it("依存の依存の KokoState は、使う側が直接の依存にしていなくても登録する（別の版とも共存する）", async () => {
    const v3 = { ...dep, version: 3, contentHash: "h3" };
    const s = usesLib2();
    s.dependencies = [v3, lib2Dep];
    const ent = s.entities[0];
    if (ent) ent.states = {};
    sim = await Simulation.create(s, "out", {
      realm: "ws",
      packages: [lib2, ...ready, { status: "ready", dependency: v3, manifest }],
    });
    expect(sim.registry.get(HEALTH)?.name).toBe("Health");
    expect(sim.registry.get(packageResourceId(v3, "ks_health"))?.name).toBe("Health");
  });
});
