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
