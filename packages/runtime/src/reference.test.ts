import type { Vec3 } from "@tukurium/eks";
import {
  BUILTIN,
  gunSample,
  OFFICIAL_COMBAT,
  officialLibraries,
  type PackageDependency,
  type PackageResolution,
  packageManifest,
  packageResourceId,
  referenceGunAndTarget,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { Simulation } from "./simulation";

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

/** サーバーが出した公式 combat の v1（hash はテストでは何でもよい。lock と一致していればよい） */
const lib = officialLibraries().find((l) => l.workId === OFFICIAL_COMBAT.workId);
const combat: PackageDependency = {
  alias: "combat",
  packageId: OFFICIAL_COMBAT.workId,
  version: 1,
  contentHash: "h",
};
const packages: PackageResolution[] = lib
  ? [{ status: "ready", dependency: combat, manifest: packageManifest(lib.snapshot) }]
  : [];
const HEALTH = packageResourceId(combat, OFFICIAL_COMBAT.health);

const fire = (origin: Vec3, direction: Vec3) => ({
  action: "fire",
  phase: "down" as const,
  origin,
  direction,
  player: "p",
});

describe("reference UGC：銃と的（公式 combat を使う。ADR 0016）", () => {
  it("公式ライブラリは Health と Damageable を公開している", () => {
    expect(
      packageManifest(lib?.snapshot ?? referenceGunAndTarget(combat)).exports.map((e) => e.path),
    ).toEqual(["/Health.koko", "/Damageable.system"]);
  });

  it("撃つと公式の Damageable が hp を減らし、0 で倒れて、しばらくすると戻る", async () => {
    sim = await Simulation.create(referenceGunAndTarget(combat), "out_range", {
      realm: "ws",
      packages,
    });
    expect(sim.systemStatus().map((s) => [s.name, s.error])).toEqual([
      ["Shoot", null],
      ["@combat/Damageable", null],
      ["TargetFall", null],
    ]);
    const hp = () => sim?.world.get("ent_target2", HEALTH)?.f_hp;
    for (let i = 0; i < 3; i++) {
      sim.input(fire([0, 1.5, 0], [0, 0, -1]));
      sim.step(1 / 60);
      for (let t = 0; t < 15; t++) sim.step(1 / 60); // 連射の間隔を待つ
    }
    expect(hp()).toBe(0);
    expect(sim.world.get("ent_target2", BUILTIN.Transform)?.rotation).toEqual([0, 0, 0]);
    // respawn（2 秒）たつと戻る
    for (let t = 0; t < 150; t++) sim.step(1 / 60);
    expect(hp()).toBe(3);
    expect(sim.world.get("ent_target2", BUILTIN.Transform)?.rotation).toEqual([90, 0, 0]);
  });

  it("別の作者の今の銃（公式ライブラリを使わない）からの Damage も、公式の Damageable が受ける", async () => {
    sim = await Simulation.createSession();
    sim.addPart({
      id: "g1",
      realm: "repoGun",
      outputId: "out_gun",
      snapshot: gunSample(),
      position: [0, 0, 0],
      yaw: 0,
    });
    const range = referenceGunAndTarget(combat);
    // 的だけを置く（銃は外す）
    range.entities = range.entities.filter((e) => e.id !== "ent_gun");
    sim.addPart({
      id: "r1",
      realm: "repoRange",
      outputId: "out_range",
      snapshot: range,
      packages,
      position: [0, 0, 0],
      yaw: 0,
    });
    sim.input(fire([0, 1.5, 0], [0, 0, -1]));
    sim.step(1 / 60);
    expect(sim.world.get("r1/ent_target2", HEALTH)?.f_hp).toBe(2);
  });
});
