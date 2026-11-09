import type { Vec3 } from "@tukurium/eks";
import {
  type CapabilityId,
  gunSample,
  HOST_CAPABILITIES,
  type ProjectSnapshot,
  targetRangeSample,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_API_POLICY } from "./capabilities";
import { type LogEntry, Simulation } from "./simulation";
import { inputWithTools } from "./testInput";

/** 実効権限：宣言（コードから読み取り）∩ 置いた物への付与 ∩ World の上限（ADR 0012、計画 UGC U1） */

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

function gunWith(code: string): ProjectSnapshot {
  const s = gunSample();
  s.systems = s.systems.map((x) => (x.id === "sys_shoot" ? { ...x, code } : x));
  return s;
}

const RAYCAST = `import Gun from "./Gun.koko";
export default system({
  query: { with: [Gun] },
  onInput(e, ev) {
    if (ev.phase !== "down") return;
    const hit = world.raycast(ev.origin, ev.direction, 100);
    log("hit", hit ? "yes" : "no");
  },
});`;

const DYNAMIC = `import Gun from "./Gun.koko";
export default system({
  query: { with: [Gun] },
  onInput(e, ev) {
    if (ev.phase !== "down") return;
    const name = "find";
    log("found", world[name]("銃"));
  },
});`;

const fire = {
  action: "fire",
  phase: "down" as const,
  origin: [0, 1.5, 0] as Vec3,
  direction: [0, 0, -1] as Vec3,
  player: "p",
};
const said = (logs: LogEntry[], p: string) =>
  logs.filter((l) => l.message.startsWith(`${p} `)).map((l) => l.message);

async function session(code: string, grants?: CapabilityId[]) {
  const logs: LogEntry[] = [];
  sim = await Simulation.createSession({ onLog: (l) => logs.push(l) });
  sim.addPart({
    id: "range",
    realm: "repoRange",
    outputId: "out_range",
    snapshot: targetRangeSample(),
    position: [0, 0, -2],
    yaw: 0,
  });
  sim.addPart({
    id: "gun",
    realm: "repoGun",
    outputId: "out_gun",
    snapshot: gunWith(code),
    position: [0, 0, 0],
    yaw: 0,
    ...(grants ? { grants } : {}),
  });
  return { s: sim, logs };
}

const warnings = (s: Simulation) =>
  s.systemStatus().find((x) => x.name === "Shoot")?.warnings ?? [];

describe("実効権限（セッション）", () => {
  it("付与を指定しなければ、コードから読み取った宣言どおりに使える", async () => {
    const { s, logs } = await session(RAYCAST);
    inputWithTools(s, fire);
    s.step(1 / 60);
    expect(said(logs, "hit")).toEqual(["hit yes"]);
    expect(s.declaredCapabilities("gun")).toEqual(["physics.raycast"]);
  });

  it("置いた物への付与に無い Capability は拒み、注意を残す（System は止めない）", async () => {
    const { s, logs } = await session(RAYCAST, []);
    inputWithTools(s, fire);
    s.step(1 / 60);
    expect(said(logs, "hit")).toEqual(["hit no"]);
    expect(warnings(s)).toEqual([
      { code: "capability-denied", message: expect.stringContaining("physics.raycast"), count: 1 },
    ]);
    expect(s.systemStatus().find((x) => x.name === "Shoot")?.error).toBeNull();
  });

  it("置いた後に付与を変えられる（null に戻すと宣言どおり）", async () => {
    const { s, logs } = await session(RAYCAST);
    s.setGrants("gun", []);
    inputWithTools(s, fire);
    s.step(1 / 60);
    s.setGrants("gun", null);
    inputWithTools(s, fire);
    s.step(1 / 60);
    expect(said(logs, "hit")).toEqual(["hit no", "hit yes"]);
  });

  it("コードから読み取れない使い方（宣言に無い Capability）はセッションでは拒む", async () => {
    const { s, logs } = await session(DYNAMIC);
    inputWithTools(s, fire);
    s.step(1 / 60);
    expect(said(logs, "found")).toEqual(["found null"]);
    expect(warnings(s)[0]).toMatchObject({ code: "capability-denied" });
  });

  it("実行の主体（PackageExecutionContext）を、置いた物と版から組み立てる", async () => {
    const { s } = await session(RAYCAST);
    expect(s.executionContext("gun", "sys_shoot")).toMatchObject({
      packageId: "workspace:repoGun",
      placementId: "gun",
      systemId: "sys_shoot",
      worldInstanceId: "session",
      resolvedVersion: expect.stringMatching(/^[0-9a-f]{8}$/),
    });
  });
});

describe("ワークスペースの再生では強制しない（利用者と決めた）", () => {
  it("コードから読み取れない使い方でも動く", async () => {
    const logs: LogEntry[] = [];
    sim = await Simulation.create(gunWith(DYNAMIC), "out_gun", {
      realm: "r",
      onLog: (l) => logs.push(l),
    });
    inputWithTools(sim, fire);
    sim.step(1 / 60);
    expect(said(logs, "found")).toEqual(["found ent_gun"]);
  });
});

describe("一つの定義", () => {
  it("HOST_API_POLICY の Capability と、コードの読み取りの表が一致する", () => {
    expect(
      Object.fromEntries(Object.entries(HOST_API_POLICY).map(([n, p]) => [n, p.capability])),
    ).toEqual(HOST_CAPABILITIES);
  });
});
