import type { Vec3 } from "@tukurium/eks";
import { BUILTIN, gunSample, type ProjectSnapshot, targetRangeSample } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";
import { inputWithTools } from "./testInput";

/**
 * UGC の境界についての、今の動きの記録（characterization。計画 UGC U0）。
 *
 * U0 で「境界がない」今の動きを記録し、U1 / U2 で ADR 0012 の表のとおりに意図して書き換えた。
 * 残っている「入力の player を申告どおりに信じる」は、サーバーでの判定（U2 以降）で書き換える。
 */

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

/** 入力を受けると、別の配置へ届くかを試して log に出す System（銃のサンプルの Gun を Query に使う） */
const PROBE = `export default system({
  query: { with: ["Gun"] },
  onInput(e, ev) {
    if (ev.phase !== "down") return;
    if (ev.action === "probe") {
      const hit = world.raycast(ev.origin, ev.direction, 100);
      log("hit", hit ? hit.entity : null);
      const found = world.find("的2");
      log("find", found);
      log("get", JSON.stringify(found ? world.get(found, "Target") : "none"));
    }
    if (ev.action === "smash") {
      const found = world.find("的2");
      if (found) world.destroy(found);
    }
    if (ev.action === "self") {
      log("self", world.find("銃"));
    }
    if (ev.action === "spawnkill") {
      const id = world.spawn({ name: "tmp" });
      log("spawned", world.find("tmp") === id);
      world.destroy(id);
      log("after", world.find("tmp"));
    }
    if (ev.action === "poke") {
      const hit = world.raycast(ev.origin, ev.direction, 100);
      if (hit) world.emit(hit.entity, "hit", { damage: 1 });
    }
  },
});`;

function probeSample(): ProjectSnapshot {
  const s = gunSample();
  s.systems = s.systems.map((x) => (x.id === "sys_shoot" ? { ...x, code: PROBE } : x));
  return s;
}

const input = (action: string, player = "p1") => ({
  action,
  phase: "down" as const,
  origin: [0, 1.5, 0] as Vec3,
  direction: [0, 0, -1] as Vec3,
  player,
});

async function session(logs: LogEntry[]) {
  sim = await Simulation.createSession({ onLog: (l) => logs.push(l) });
  sim.addPart({
    id: "attacker",
    realm: "repoAttacker",
    outputId: "out_gun",
    snapshot: probeSample(),
    position: [0, 0, 0],
    yaw: 0,
  });
  sim.addPart({
    id: "victim",
    realm: "repoVictim",
    outputId: "out_range",
    snapshot: targetRangeSample(),
    position: [0, 0, -2],
    yaw: 0,
  });
  return sim;
}

const messages = (logs: LogEntry[]) => logs.filter((l) => l.level === "log").map((l) => l.message);

describe("U2：別の配置へは opaque handle と公開 Contract だけ（ADR 0012）", () => {
  it("Raycast は、別の配置の Entity の生の ID を返さない（handle の token だけ）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    inputWithTools(s, input("probe"));
    s.step(1 / 60);
    expect(messages(logs)).toContain("hit null");
  });

  it("world.emit は、別の配置の Entity には届かない（見つからないのと同じ）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    inputWithTools(s, input("poke"));
    s.step(1 / 60);
    expect(s.world.get("victim/ent_target2", s.stateIdOf("victim", "ks_target") ?? "")?.f_hp).toBe(
      3,
    );
  });
});

describe("U1：別の配置は「見つからない」（ADR 0012）", () => {
  it("world.find は、自分の配置の中だけを探す", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    inputWithTools(s, input("probe"));
    s.step(1 / 60);
    expect(messages(logs)).toContain("find null");
    expect(messages(logs)).toContain('get "none"');
  });

  it("world.destroy は、別の配置の Entity を消せない（見つからないのと同じで、何も起きない）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    inputWithTools(s, input("smash"));
    s.step(1 / 60);
    expect(s.world.has("victim/ent_target2")).toBe(true);
  });

  it("同じアウトプットを 2 か所に置いても、それぞれ自分の配置の Entity だけが見える", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.addPart({
      id: "attacker2",
      realm: "repoAttacker",
      outputId: "out_gun",
      snapshot: probeSample(),
      position: [3, 0, 0],
      yaw: 0,
    });
    inputWithTools(s, input("self"));
    s.step(1 / 60);
    expect(
      messages(logs)
        .filter((m) => m.startsWith("self"))
        .sort(),
    ).toEqual(["self attacker/ent_gun", "self attacker2/ent_gun"]);
  });

  it("world.spawn で作った Entity は、作った System の配置のものになる（自分で消せる）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    inputWithTools(s, input("spawnkill"));
    s.step(1 / 60);
    expect(messages(logs)).toContain("spawned true");
    expect(messages(logs)).toContain("after null");
  });
});

describe("今の動き：入力の player は申告どおりに信じる", () => {
  it("Grabbable を持つ・動かすのは、入力に書かれた player として扱われる", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    // 的 2 を持てるようにする（Collider は的のサンプルに付いている）
    s.world.add("victim/ent_target2", BUILTIN.Grabbable, { distance: 1.2 });
    // つかめる距離（6m）まで近づいてから右クリック
    inputWithTools(s, { ...input("grab", "alice"), origin: [0, 1.5, -3] as Vec3 });
    s.step(1 / 60);
    expect(s.world.get("victim/ent_target2", BUILTIN.Grabbable)?.player).toBe("alice");
    // 別の人が player を "alice" と書いた入力でも、alice の持っている物を放せる
    inputWithTools(s, {
      ...input("grab", "alice"),
      origin: [0, 1.5, -3] as Vec3,
      phase: "up" as const,
    });
    s.step(1 / 60);
    expect(s.world.get("victim/ent_target2", BUILTIN.Grabbable)?.player).toBe("");
  });
});
