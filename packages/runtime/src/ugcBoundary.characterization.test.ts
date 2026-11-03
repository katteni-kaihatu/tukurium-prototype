import type { Vec3 } from "@tukurium/eks";
import { BUILTIN, gunSample, type ProjectSnapshot, targetRangeSample } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";

/**
 * UGC の境界についての、今の動きの記録（characterization。計画 UGC U0）。
 *
 * ここに書いた動きの多くは「境界がない」ことを示しており、望ましい仕様ではない。
 * U1 / U2 で Capability gateway と対象の policy を入れるときに、このテストを
 * 意図して書き換える（黙って壊さない）。どの行をどう変えるかは ADR 0012 の表に従う。
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
    if (ev.action === "poke") {
      const found = world.find("的2");
      if (found) world.emit(found, "hit", { damage: 1 });
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

describe("今の動き：配置（別の作者の Item / World）の間に境界がない", () => {
  it("Raycast は、別の配置の Entity の生の ID を返す（発見できる）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.input(input("probe"));
    s.step(1 / 60);
    expect(messages(logs)).toContain("hit victim/ent_target2");
  });

  it("world.find は、配置をまたいで名前で Entity を探せる", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.input(input("probe"));
    s.step(1 / 60);
    expect(messages(logs)).toContain("find victim/ent_target2");
  });

  it("world.get は、呼んだ側の KokoState の名前で引くので、別の領域の状態は読めない", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.input(input("probe"));
    s.step(1 / 60);
    expect(messages(logs)).toContain("get null");
  });

  it("world.emit は、別の配置の Entity にイベントを送れる（的の System が受けて hp が減る）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.input(input("poke"));
    s.step(1 / 60);
    expect(s.world.get("victim/ent_target2", "repoVictim:ks_target")?.f_hp).toBe(2);
  });

  it("world.destroy は、別の配置の Entity も消せる", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    expect(s.world.has("victim/ent_target2")).toBe(true);
    s.input(input("smash"));
    s.step(1 / 60);
    expect(s.world.has("victim/ent_target2")).toBe(false);
  });
});

describe("今の動き：入力の player は申告どおりに信じる", () => {
  it("Grabbable を持つ・動かすのは、入力に書かれた player として扱われる", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    // 的 2 を持てるようにする（Collider は的のサンプルに付いている）
    s.world.add("victim/ent_target2", BUILTIN.Grabbable, { distance: 1.2 });
    // つかめる距離（6m）まで近づいてから右クリック
    s.input({ ...input("grab", "alice"), origin: [0, 1.5, -3] as Vec3 });
    s.step(1 / 60);
    expect(s.world.get("victim/ent_target2", BUILTIN.Held)?.player).toBe("alice");
    // 別の人が player を "alice" と書いた入力でも、alice の持っている物を放せる
    s.input({ ...input("grab", "alice"), origin: [0, 1.5, -3] as Vec3, phase: "up" as const });
    s.step(1 / 60);
    expect(s.world.hasState("victim/ent_target2", BUILTIN.Held)).toBe(false);
  });
});

describe("U1 で満たすこと（今は満たしていない）", () => {
  // U1 / U2 の最初の縦の一本で、Raycast の結果を opaque handle にする（ADR 0012）。
  // 今は生の Entity ID が返るので、このテストは「失敗すること」を確かめている。
  it.fails("Raycast の結果に、別の配置の生の Entity ID が含まれない", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.input(input("probe"));
    s.step(1 / 60);
    expect(messages(logs).some((m) => m.startsWith("hit victim/"))).toBe(false);
  });
});
