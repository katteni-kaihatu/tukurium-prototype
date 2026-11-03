import type { Vec3 } from "@tukurium/eks";
import { gunSample, type ProjectSnapshot, targetRangeSample } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";

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

const hp = (s: Simulation) => s.world.get("range/ent_target2", "repoRange:ks_target")?.f_hp;
const said = (logs: LogEntry[], prefix: string) =>
  logs.filter((l) => l.level === "log" && l.message.startsWith(`${prefix} `)).map((l) => l.message);

describe("公開 Contract と opaque handle", () => {
  it("別の配置に当たった Raycast は、生の Entity ID を持たず token を持つ", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.input(input("look"));
    s.step(1 / 60);
    expect(said(logs, "look")).toEqual(['look {"entity":null,"token":"string","distance":7}']);
  });

  it("hit.send で公開された Damage を送ると、的の contracts.Damage が受けて hp が減る", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.input(input("shoot"));
    s.step(1 / 60);
    expect(said(logs, "sent")).toEqual(["sent true"]);
    expect(hp(s)).toBe(2);
  });

  it("handle は一度だけ使える（同じ要求の二重配送を防ぐ）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.input(input("twice"));
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
    s.input(input("forge"));
    s.input(input("copy"));
    s.input(input("keep"));
    s.step(1 / 60);
    for (let i = 0; i < 90; i++) s.step(1 / 60);
    s.input(input("reuse"));
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
    s.input(input("keep"));
    s.step(1 / 60);
    s.input(input("reuse2"));
    s.step(1 / 60);
    expect(said(logs, "reuse2")).toEqual(["reuse2 false"]);
    expect(hp(s)).toBe(3);
  });

  it("相手の公開範囲が「衝突のみ」なら、Raycast は当たるが Contract は届かない", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs, "collision");
    s.input(input("shoot"));
    s.step(1 / 60);
    expect(said(logs, "sent")).toEqual(["sent false"]);
    expect(hp(s)).toBe(3);
  });

  it("相手が「非公開」なら、Raycast は当たらない（見つからない）", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs, "private");
    s.input(input("shoot"));
    s.step(1 / 60);
    expect(said(logs, "sent")).toEqual(["sent nohit"]);
  });

  it("payload は Contract の schema で検証し、知らない Contract は使えない", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    s.input(input("bad"));
    s.step(1 / 60);
    expect(s.systemStatus().find((x) => x.name === "Shoot")?.error).toContain("amount");
    expect(hp(s)).toBe(3);
  });
});
