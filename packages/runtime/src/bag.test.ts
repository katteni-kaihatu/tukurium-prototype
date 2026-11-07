import type { Vec3 } from "@tukurium/eks";
import {
  OFFICIAL_ITEMS,
  officialLibraries,
  type PackageDependency,
  type PackageResolution,
  type ProjectSnapshot,
  packageManifest,
  referenceKeyAndDoor,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { BAG_LIMIT, Simulation } from "./simulation";

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

const lib = officialLibraries().find((l) => l.workId === OFFICIAL_ITEMS.workId);
const items: PackageDependency = {
  alias: "items",
  packageId: OFFICIAL_ITEMS.workId,
  version: 1,
  contentHash: "h",
};
const packages: PackageResolution[] = lib
  ? [{ status: "ready", dependency: items, manifest: packageManifest(lib.snapshot, lib.outputId) }]
  : [];

/** origin から -z を見て E を押す */
const press = (s: Simulation, origin: Vec3, player = "p") =>
  s.input({ action: "use", phase: "down", origin, direction: [0, 0, -1], player });
const KEY_AT: Vec3 = [-1, 0.6, 0];
const DOOR_AT: Vec3 = [1, 1, -1];

const doorY = (s: Simulation, id = "ent_locked_door") =>
  (s.world.get(id, "builtin.Transform")?.position as Vec3 | undefined)?.[1];

describe("プレイヤーのバッグ（ADR 0018）", () => {
  it("鍵を E で拾うとバッグに入って消え、鍵のかかった扉を E で押すと取り出して開く", async () => {
    sim = await Simulation.create(referenceKeyAndDoor(items), "out_key_door", {
      realm: "ws",
      packages,
    });
    expect(sim.systemStatus().map((s) => [s.name, s.error])).toEqual([
      ["@items/KeyPickup", null],
      ["LockedDoor", null],
    ]);
    press(sim, DOOR_AT);
    sim.step(1 / 60);
    expect(doorY(sim)).toBe(1); // 鍵がないので開かない

    press(sim, KEY_AT);
    sim.step(1 / 60);
    expect(sim.world.has("ent_key")).toBe(false);
    expect(sim.bagsSnapshot().p).toEqual([
      expect.objectContaining({ name: "Key", values: { color: "#f1c40f" } }),
    ]);

    press(sim, DOOR_AT);
    sim.step(1 / 60);
    for (let t = 0; t < 120; t++) sim.step(1 / 60);
    expect(doorY(sim)).toBeCloseTo(3.2);
    expect(sim.bagsSnapshot().p).toEqual([]);
  });

  it("ほかの人の鍵では開かない（バッグはプレイヤーごと）", async () => {
    sim = await Simulation.create(referenceKeyAndDoor(items), "out_key_door", {
      realm: "ws",
      packages,
    });
    press(sim, KEY_AT, "alice");
    sim.step(1 / 60);
    press(sim, DOOR_AT, "bob");
    for (let t = 0; t < 60; t++) sim.step(1 / 60);
    expect(doorY(sim)).toBe(1);
    expect(sim.bagsSnapshot().alice).toHaveLength(1);
  });

  it("別の作者の作品で拾った鍵で、別の作者の扉を開けられる（同じ公式 items の版）", async () => {
    sim = await Simulation.createSession();
    const keys = referenceKeyAndDoor(items);
    keys.entities = keys.entities.filter((e) => e.id === "ent_key");
    const doors = referenceKeyAndDoor(items);
    doors.entities = doors.entities.filter((e) => e.id === "ent_locked_door");
    const at = { position: [0, 0, 0] as Vec3, yaw: 0 };
    sim.addPart({
      id: "a",
      realm: "repoA",
      outputId: "out_key_door",
      snapshot: keys,
      packages,
      ...at,
    });
    sim.addPart({
      id: "b",
      realm: "repoB",
      outputId: "out_key_door",
      snapshot: doors,
      packages,
      ...at,
    });
    press(sim, KEY_AT);
    sim.step(1 / 60);
    press(sim, DOOR_AT);
    for (let t = 0; t < 120; t++) sim.step(1 / 60);
    expect(doorY(sim, "b/ent_locked_door")).toBeCloseTo(3.2);
  });

  it("Interact の外や、自分のプロジェクトの KokoState では、バッグに触れられない", async () => {
    const snap: ProjectSnapshot = referenceKeyAndDoor(items);
    snap.systems.push({
      id: "sys_peek",
      name: "Peek",
      code: `import Key from "@items/Key.koko";
import Lock from "./Lock.koko";
export default system({
  query: { with: [Lock] },
  onUpdate(e) { e.get(Lock).height = bag.count(Key); },
  contracts: { Interact(e) { bag.add(Lock, {}); } },
});`,
    });
    const out = snap.outputs[0];
    if (out) out.systems = [{ id: "sys_peek", enabled: true }];
    sim = await Simulation.create(snap, "out_key_door", { realm: "ws", packages });
    press(sim, DOOR_AT);
    sim.step(1 / 60);
    const warnings = sim.systemStatus()[0]?.warnings?.map((w) => w.code) ?? [];
    expect(warnings).toEqual(expect.arrayContaining(["bag-outside-interact", "bag-type-invalid"]));
    expect(sim.bagsSnapshot().p ?? []).toEqual([]);
  });

  it("バッグはスナップショットから戻せる（ホストが替わったとき）。入るのは 64 個まで", async () => {
    sim = await Simulation.create(referenceKeyAndDoor(items), "out_key_door", {
      realm: "ws",
      packages,
    });
    const many = Array.from({ length: BAG_LIMIT + 5 }, () => ({
      type: "pkg:w_official_items@1/ks_key",
      name: "Key",
      values: { color: "#f1c40f" },
    }));
    sim.restoreBags({ p: many });
    expect(sim.bagsSnapshot().p).toHaveLength(BAG_LIMIT);
    // いっぱいなら拾えない（鍵は残る）
    press(sim, KEY_AT);
    sim.step(1 / 60);
    expect(sim.world.has("ent_key")).toBe(true);
  });
});
