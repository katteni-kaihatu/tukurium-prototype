import type { Vec3 } from "@tukurium/eks";
import {
  BUILTIN,
  gunSample,
  OFFICIAL_COMBAT,
  OFFICIAL_INTERACTION,
  officialLibraries,
  type PackageDependency,
  type PackageResolution,
  packageManifest,
  packageResourceId,
  referenceDoorAndSwitch,
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

describe("reference UGC：扉とスイッチ（公式 interaction を使う。ADR 0016）", () => {
  const ilib = officialLibraries().find((l) => l.workId === OFFICIAL_INTERACTION.workId);
  const interaction: PackageDependency = {
    alias: "interaction",
    packageId: OFFICIAL_INTERACTION.workId,
    version: 1,
    contentHash: "hi",
  };
  const ipackages: PackageResolution[] = ilib
    ? [{ status: "ready", dependency: interaction, manifest: packageManifest(ilib.snapshot) }]
    : [];
  const TOGGLE = packageResourceId(interaction, OFFICIAL_INTERACTION.toggle);
  /** スイッチ（[1.2, 1.2, -3]）を見て E を押す */
  const press = (s: Simulation, player = "p") =>
    s.input({ action: "use", phase: "down", origin: [1.2, 1.2, 0], direction: [0, 0, -1], player });

  it("E でスイッチを押すと扉が開き、もう一度押すと閉じる", async () => {
    sim = await Simulation.create(referenceDoorAndSwitch(interaction), "out_door", {
      realm: "ws",
      packages: ipackages,
    });
    expect(sim.systemStatus().map((s) => [s.name, s.error])).toEqual([
      ["@interaction/Toggleable", null],
      ["DoorSwing", null],
      ["SwitchLight", null],
    ]);
    press(sim);
    sim.step(1 / 60);
    expect(sim.world.get("ent_switch", TOGGLE)?.f_on).toBe(true);
    for (let t = 0; t < 60; t++) sim.step(1 / 60);
    expect(sim.world.get("ent_hinge", BUILTIN.Transform)?.rotation).toEqual([0, 90, 0]);
    expect(sim.world.get("ent_switch", BUILTIN.Mesh)?.color).toBe("#2ecc71");
    press(sim);
    for (let t = 0; t < 60; t++) sim.step(1 / 60);
    expect(sim.world.get("ent_switch", TOGGLE)?.f_on).toBe(false);
    expect(sim.world.get("ent_hinge", BUILTIN.Transform)?.rotation).toEqual([0, 0, 0]);
  });

  it("遠すぎる物・何も受け付けない物には届かない", async () => {
    sim = await Simulation.create(referenceDoorAndSwitch(interaction), "out_door", {
      realm: "ws",
      packages: ipackages,
    });
    sim.input({
      action: "use",
      phase: "down",
      origin: [1.2, 1.2, 10],
      direction: [0, 0, -1],
      player: "p",
    });
    sim.step(1 / 60);
    expect(sim.world.get("ent_switch", TOGGLE)?.f_on).toBe(false);
  });

  it("スクリプトからは Interact を送れない（プレイヤーを名乗れない）", async () => {
    const snap = referenceDoorAndSwitch(interaction);
    snap.systems.push({
      id: "sys_fake",
      name: "Fake",
      code: `import Door from "./Door.koko";
export default system({ query: { with: [Door] }, onInput(e, ev) {
  const hit = world.raycast([1.2, 1.2, 0], [0, 0, -1], 10);
  if (hit) hit.send("Interact", { player: "someone" });
} });`,
    });
    const out = snap.outputs[0];
    if (out) out.systems.push({ id: "sys_fake", enabled: true });
    sim = await Simulation.create(snap, "out_door", { realm: "ws", packages: ipackages });
    sim.input({
      action: "fire",
      phase: "down",
      origin: [0, 0, 0],
      direction: [0, 0, -1],
      player: "p",
    });
    sim.step(1 / 60);
    expect(sim.systemStatus().find((s) => s.name === "Fake")?.error).toContain("プレイヤーの操作");
    expect(sim.world.get("ent_switch", TOGGLE)?.f_on).toBe(false);
  });

  it("セッションでは、相手の「外からの見え方」がインタラクション可能なときだけ届く", async () => {
    for (const [exposure, on] of [
      ["interactive", true],
      ["collision", false],
      ["private", false],
    ] as const) {
      sim?.dispose();
      sim = await Simulation.createSession();
      const snap = referenceDoorAndSwitch(interaction);
      const out = snap.outputs[0];
      if (out) out.exposure = exposure;
      sim.addPart({
        id: "d1",
        realm: "repoDoor",
        outputId: "out_door",
        snapshot: snap,
        packages: ipackages,
        position: [0, 0, 0],
        yaw: 0,
      });
      press(sim);
      sim.step(1 / 60);
      expect([exposure, sim.world.get("d1/ent_switch", TOGGLE)?.f_on]).toEqual([exposure, on]);
    }
  });
});
