import type { Vec3 } from "@tukurium/eks";
import { gunSample, type ProjectSnapshot, targetRangeSample } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";
import { inputWithTools } from "./testInput";

/**
 * 公開 Contract と opaque handle（ADR 0012、計画 UGC U2 の最初の縦の一本）。
 * 外部の銃が、別の配置の的の Collider を Raycast し、内部の Entity を取らずに、
 * 公開された Damage Contract だけを呼ぶ。
 */

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

const PROBE = `export default system({
  query: { with: ["Gun"] },
  onInput(e, ev) {
    if (ev.phase !== "down") return;
    const hit = world.raycast(ev.origin, ev.direction, 100);
    if (ev.action === "look") {
      log("look", JSON.stringify({ entity: hit && hit.entity, token: typeof (hit && hit.token), distance: hit && Math.round(hit.distance) }));
    }
    if (ev.action === "shoot") log("sent", hit ? hit.send("Damage", { amount: 1 }) : "nohit");
    if (ev.action === "twice") {
      log("first", hit.send("Damage", { amount: 1 }));
      log("second", hit.send("Damage", { amount: 1 }));
    }
    if (ev.action === "keep" && hit && e.id.startsWith("gun/")) globalThis.kept = hit;
    if (ev.action === "reuse") log("reuse", globalThis.kept.send("Damage", { amount: 1 }));
    if (ev.action === "reuse2" && e.id.startsWith("gun2/")) log("reuse2", globalThis.kept.send("Damage", { amount: 1 }));
    if (ev.action === "forge") log("forge", contract.send("tk_forged", "Damage", { amount: 1 }));
    if (ev.action === "copy") log("copy", contract.send(JSON.parse(JSON.stringify(hit)).token + "x", "Damage", { amount: 1 }));
    if (ev.action === "spark") {
      log("fx1", hit.effect("spark", { color: "#ffaa00", size: 5, life: 10 }));
      log("fx2", hit.effect("spark"));
    }
    if (ev.action === "bad") hit.send("Damage", { amount: "lots" });
    if (ev.action === "heal") hit.send("Heal", { amount: 1 });
  },
});`;

function probeSample(): ProjectSnapshot {
  const s = gunSample();
  s.systems = s.systems.map((x) => (x.id === "sys_shoot" ? { ...x, code: PROBE } : x));
  return s;
}

function range(exposure?: "private" | "collision" | "interactive"): ProjectSnapshot {
  const s = targetRangeSample();
  if (exposure) s.outputs = s.outputs.map((o) => ({ ...o, exposure }));
  return s;
}

const input = (action: string, origin: Vec3 = [0, 1.5, 0]) => ({
  action,
  phase: "down" as const,
  origin,
  direction: [0, 0, -1] as Vec3,
  player: "p1",
});

async function session(logs: LogEntry[], exposure?: "private" | "collision" | "interactive") {
  sim = await Simulation.createSession({ onLog: (l) => logs.push(l) });
  sim.addPart({
    id: "gun",
    realm: "repoGun",
    outputId: "out_gun",
    snapshot: probeSample(),
    position: [0, 0, 0],
    yaw: 0,
  });
  sim.addPart({
    id: "range",
    realm: "repoRange",
    outputId: "out_range",
    snapshot: range(exposure),
    position: [0, 0, -2],
    yaw: 0,
  });
  return sim;
}

const hp = (s: Simulation) =>
  s.world.get("range/ent_target2", s.stateIdOf("range", "ks_target") ?? "")?.f_hp;
const said = (logs: LogEntry[], prefix: string) =>
  logs.filter((l) => l.level === "log" && l.message.startsWith(`${prefix} `)).map((l) => l.message);

describe("公開 Contract と opaque handle", () => {
  it("別の配置に当たった Raycast は、生の Entity ID を持たず token を持つ", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    inputWithTools(s, input("look"));
    s.step(1 / 60);
    expect(said(logs, "look")).toEqual(['look {"entity":null,"token":"string","distance":7}']);
  });

  it("hit.send で公開された Damage を送ると、的の contracts.Damage が受けて hp が減る", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    inputWithTools(s, input("shoot"));
    s.step(1 / 60);
    expect(said(logs, "sent")).toEqual(["sent true"]);
    expect(hp(s)).toBe(2);
  });

  it("handle は一度だけ使える（同じ要求の二重配送を防ぐ）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    inputWithTools(s, input("twice"));
    s.step(1 / 60);
    expect([...said(logs, "first"), ...said(logs, "second")]).toEqual([
      "first true",
      "second false",
    ]);
    expect(hp(s)).toBe(2);
  });

  it("偽の token・作り直した token・期限の切れた token は使えない", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    inputWithTools(s, input("forge"));
    inputWithTools(s, input("copy"));
    inputWithTools(s, input("keep"));
    s.step(1 / 60);
    for (let i = 0; i < 90; i++) s.step(1 / 60);
    inputWithTools(s, input("reuse"));
    s.step(1 / 60);
    expect([...said(logs, "forge"), ...said(logs, "copy"), ...said(logs, "reuse")]).toEqual([
      "forge false",
      "copy false",
      "reuse false",
    ]);
    expect(hp(s)).toBe(3);
  });

  it("別の配置で発行された handle は使えない（同じ System を 2 か所に置いても）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.addPart({
      id: "gun2",
      realm: "repoGun",
      outputId: "out_gun",
      snapshot: probeSample(),
      position: [30, 0, 0],
      yaw: 0,
    });
    // gun の Entity の処理で発行した handle を、gun2 の Entity の処理で使う
    inputWithTools(s, input("keep"));
    s.step(1 / 60);
    inputWithTools(s, input("reuse2"));
    s.step(1 / 60);
    expect(said(logs, "reuse2")).toEqual(["reuse2 false"]);
    expect(hp(s)).toBe(3);
  });

  it("相手の公開範囲が「衝突のみ」なら、Raycast は当たるが Contract は届かない", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs, "collision");
    inputWithTools(s, input("shoot"));
    s.step(1 / 60);
    expect(said(logs, "sent")).toEqual(["sent false"]);
    expect(hp(s)).toBe(3);
  });

  it("相手が「非公開」なら、Raycast は当たらない（見つからない）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs, "private");
    inputWithTools(s, input("shoot"));
    s.step(1 / 60);
    expect(said(logs, "sent")).toEqual(["sent nohit"]);
  });

  it("payload は Contract の schema で検証し、知らない Contract は使えない", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    inputWithTools(s, input("bad"));
    s.step(1 / 60);
    expect(s.systemStatus().find((x) => x.name === "Shoot")?.error).toContain("amount");
    expect(hp(s)).toBe(3);
  });

  it("hit.effect で、当たった点に一時的な effect を出せる（一つの handle で一つ。大きさと寿命には上限）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs, "collision");
    inputWithTools(s, input("spark"));
    s.step(1 / 60);
    expect([...said(logs, "fx1"), ...said(logs, "fx2")]).toEqual(["fx1 true", "fx2 false"]);
    const fx = s.drainEffects();
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({ kind: "spark", color: "#ffaa00", size: 1, life: 2 });
    expect(fx[0]?.position[2]).toBeCloseTo(-6.96, 1);
    expect(s.drainEffects()).toEqual([]);
    // effect は World の状態にも、的の hp にも影響しない
    expect(hp(s)).toBe(3);
  });
});

describe("World の上限（外から来た Item に許すこと。ADR 0012）", () => {
  /** 射撃場を World にして、外から来た Item（別の作者の銃）に許すことを決める */
  function world(guestPolicy?: "deny" | "collision" | "interactive"): ProjectSnapshot {
    const s = targetRangeSample();
    s.outputs = s.outputs.map((o) => ({
      ...o,
      kind: "world" as const,
      ...(guestPolicy ? { guestPolicy } : {}),
    }));
    return s;
  }

  async function inWorld(logs: LogEntry[], guestPolicy?: "deny" | "collision" | "interactive") {
    sim = await Simulation.createSession({ onLog: (l) => logs.push(l) });
    // 最初に置いた World が土台になる
    sim.addPart({
      id: "range",
      realm: "repoRange",
      outputId: "out_range",
      snapshot: world(guestPolicy),
      position: [0, 0, -2],
      yaw: 0,
    });
    sim.addPart({
      id: "gun",
      realm: "repoGun",
      outputId: "out_gun",
      snapshot: probeSample(),
      position: [0, 0, 0],
      yaw: 0,
    });
    return sim;
  }

  it("初期値（インタラクション可能）なら、外から来た銃も Damage を送れる", async () => {
    const logs: LogEntry[] = [];
    const s = await inWorld(logs);
    inputWithTools(s, input("shoot"));
    s.step(1 / 60);
    expect(said(logs, "sent")).toEqual(["sent true"]);
    expect(hp(s)).toBe(2);
  });

  it("「衝突のみ」なら、当たって effect は出せるが、Contract は送れない", async () => {
    const logs: LogEntry[] = [];
    const s = await inWorld(logs, "collision");
    inputWithTools(s, input("spark"));
    inputWithTools(s, input("shoot"));
    s.step(1 / 60);
    expect(said(logs, "fx1")).toEqual(["fx1 true"]);
    expect(said(logs, "sent")).toEqual(["sent false"]);
    expect(hp(s)).toBe(3);
  });

  it("「許さない」なら、外から来た銃からは、自分の配置の外は見つからない", async () => {
    const logs: LogEntry[] = [];
    const s = await inWorld(logs, "deny");
    inputWithTools(s, input("shoot"));
    s.step(1 / 60);
    expect(said(logs, "sent")).toEqual(["sent nohit"]);
  });

  it("土台は最初に置いた World。あとから置いた World の上限は、外から来た Item にかからない", async () => {
    const logs: LogEntry[] = [];
    const s = await inWorld(logs);
    const other = world("deny");
    s.addPart({
      id: "range2",
      realm: "repoOther",
      outputId: "out_range",
      snapshot: other,
      position: [50, 0, 0],
      yaw: 0,
    });
    inputWithTools(s, input("shoot"));
    s.step(1 / 60);
    expect(said(logs, "sent")).toEqual(["sent true"]);
  });
});

describe("拒否の知らせ（Runtime Diagnostic。ADR 0012）", () => {
  const warningsOf = (s: Simulation) => s.systemStatus().find((x) => x.name === "Shoot")?.warnings;

  it("公開された相手に拒まれたら、送った System に注意を残す（同じ注意は回数を数える）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs, "collision");
    inputWithTools(s, input("shoot"));
    s.step(1 / 60);
    inputWithTools(s, input("shoot"));
    s.step(1 / 60);
    expect(warningsOf(s)).toEqual([
      { code: "contract-denied", message: expect.stringContaining("Damage"), count: 2 },
    ]);
  });

  it("非公開の相手は「見つからない」ので、注意も出さない（存在を漏らさない）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs, "private");
    inputWithTools(s, input("shoot"));
    s.step(1 / 60);
    expect(warningsOf(s)).toEqual([]);
  });
});
