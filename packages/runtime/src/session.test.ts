import type { Vec3 } from "@tukurium/eks";
import { BUILTIN, gunSample, type ProjectSnapshot, targetRangeSample } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

const fire = (origin: Vec3, direction: Vec3, action = "fire") => ({
  action,
  phase: "down" as const,
  origin,
  direction,
  player: "p",
});

async function session(logs: LogEntry[] = []) {
  sim = await Simulation.createSession({ onLog: (l) => logs.push(l) });
  sim.addPart({
    id: "g1",
    realm: "repoGun",
    outputId: "out_gun",
    snapshot: gunSample(),
    position: [0, 0, 0],
    yaw: 0,
  });
  sim.addPart({
    id: "r1",
    realm: "repoRange",
    outputId: "out_range",
    snapshot: targetRangeSample(),
    position: [0, 0, -2],
    yaw: 0,
  });
  return sim;
}

const hp = (s: Simulation, target: string) =>
  s.world.get(`r1/${target}`, "repoRange:ks_target")?.f_hp;
const ammo = (s: Simulation) => s.world.get("g1/ent_gun", "repoGun:ks_gun")?.f_ammo;

describe("セッションの世界（複数の配置）", () => {
  it("別のリポジトリの銃で、別のリポジトリの的を撃てる。配置の位置が反映される", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    expect(s.world.get("r1/ent_target2", BUILTIN.Transform)?.position).toEqual([0, 1.5, -7]);
    s.input(fire([0, 1.5, 0], [0, 0, -1]));
    s.step(1 / 60);
    expect(ammo(s)).toBe(11);
    expect(hp(s, "ent_target2")).toBe(2);
    expect(s.nameOf("r1/ent_target2")).toBe("的2");
    expect(
      s
        .materials()
        .map((m) => m.id)
        .sort(),
    ).toEqual(["repoGun:mat_gun", "repoRange:mat_wood"]);
    expect(s.world.get("g1/ent_gun", BUILTIN.Mesh)?.material).toBe("repoGun:mat_gun");
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("同じアウトプットを 2 回配置しても、System は 1 回ずつしか動かない", async () => {
    const s = await session();
    s.addPart({
      id: "r2",
      realm: "repoRange",
      outputId: "out_range",
      snapshot: targetRangeSample(),
      position: [5, 0, -2],
      yaw: 0,
    });
    expect(s.systemStatus().filter((x) => x.name === "TargetHit")).toHaveLength(1);
    s.input(fire([5, 1.5, 0], [0, 0, -1]));
    s.step(1 / 60);
    expect(s.world.get("r2/ent_target2", "repoRange:ks_target")?.f_hp).toBe(2);
    expect(hp(s, "ent_target2")).toBe(3);
  });

  it("適用：マークしたフィールド（残弾）は実行値を保ち、ほかは新しい値・新しいコードになる", async () => {
    const s = await session();
    s.input(fire([0, 1.5, 0], [0, 0, -1]));
    s.step(1 / 60);
    expect(ammo(s)).toBe(11);

    // 改造：威力 3、連射間隔 0（エンティティの値とコードを変える）
    const next = gunSample();
    const gun = next.entities.find((e) => e.id === "ent_gun");
    if (gun?.states.ks_gun) {
      gun.states.ks_gun.f_damage = 3;
      gun.states.ks_gun.f_ammo = 99;
    }
    const sys = next.systems[0];
    if (sys) sys.code = sys.code.replace('log("リロード", gun.ammo);', 'log("改造版のリロード");');
    const report = s.applyPart("repoGun", "out_gun", next);
    expect(report).toEqual({ instances: 1, kept: 1, dropped: 0 });
    expect(ammo(s)).toBe(11); // マークあり：実行値を保つ
    expect(s.world.get("g1/ent_gun", "repoGun:ks_gun")?.f_damage).toBe(3); // マークなし：新しい値

    for (let i = 0; i < 15; i++) s.step(1 / 60);
    s.input(fire([0, 1.5, 0], [0, 0, -1]));
    s.step(1 / 60);
    expect(hp(s, "ent_target2")).toBeLessThanOrEqual(0); // 2 - 3 → 倒れる
    // 的の配置はそのまま（適用は銃のリポジトリだけ）
    expect(
      s
        .partList()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["g1", "r1"]);
  });

  it("適用：型が変わったフィールドは引き継がず、初期値に戻す", async () => {
    const s = await session();
    const next = gunSample();
    const def = next.kokostates[0];
    if (def)
      def.fields = def.fields.map((f) =>
        f.id === "f_ammo" ? { ...f, type: "string", default: "many" } : f,
      );
    const gun = next.entities.find((e) => e.id === "ent_gun");
    if (gun?.states.ks_gun) gun.states.ks_gun.f_ammo = "many";
    expect(s.applyPart("repoGun", "out_gun", next)).toEqual({ instances: 1, kept: 0, dropped: 1 });
    expect(ammo(s)).toBe("many");
  });

  it("リセット：実行値を捨てて初期値に戻す", async () => {
    const s = await session();
    s.input(fire([0, 1.5, 0], [0, 0, -1]));
    s.step(1 / 60);
    expect(ammo(s)).toBe(11);
    s.resetPart("g1");
    expect(ammo(s)).toBe(12);
  });

  it("別のリポジトリに同じ名前の KokoState があっても、それぞれのスクリプトは自分の定義を使う", async () => {
    const other: ProjectSnapshot = {
      ...targetRangeSample(),
      name: "別の銃",
      kokostates: [
        {
          id: "ks_gun",
          name: "Gun",
          fields: [{ id: "f_x", name: "x", type: "number", default: 7 }],
        },
      ],
      systems: [
        {
          id: "sys_x",
          name: "X",
          code: `export default system({ query: { with: ["Gun"] }, onUpdate(e) { e.Gun.x += 1; } });`,
        },
      ],
      outputs: [
        {
          id: "out_x",
          name: "x",
          kind: "item",
          systems: [{ id: "sys_x", enabled: true }],
          keep: [],
        },
      ],
      entities: [
        {
          id: "e",
          name: "e",
          parent: null,
          output: "out_x",
          order: 0,
          states: { ks_gun: { f_x: 7 } },
        },
      ],
    };
    const s = await session();
    s.addPart({
      id: "x1",
      realm: "repoX",
      outputId: "out_x",
      snapshot: other,
      position: [0, 0, 0],
      yaw: 0,
    });
    s.step(1 / 60);
    expect(s.world.get("x1/e", "repoX:ks_gun")?.f_x).toBe(8);
    // 銃のリポジトリの Gun には触れていない
    expect(s.world.get("g1/ent_gun", "repoGun:ks_gun")?.f_ammo).toBe(12);
    expect(s.systemStatus().every((x) => x.error === null)).toBe(true);
  });

  it("配置を外すと、その Entity と System がなくなる", async () => {
    const s = await session();
    s.removePart("r1");
    expect(s.world.entityIds().every((id) => id.startsWith("g1/"))).toBe(true);
    expect(s.systemStatus().map((x) => x.name)).toEqual(["Shoot"]);
  });
});

describe("音", () => {
  it("audio.play で、名前で指定した音を Entity の位置で鳴らす", async () => {
    const snap = gunSample();
    const clip = "a".repeat(64);
    snap.assets = [{ id: clip, name: "shot", kind: "audio", contentType: "audio/ogg" }];
    const sys = snap.systems[0];
    if (sys)
      sys.code = sys.code.replace(
        "gun.ammo -= 1;",
        'gun.ammo -= 1; audio.play("shot", e.id, 0.5);',
      );
    sim = await Simulation.createSession();
    sim.addPart({
      id: "g1",
      realm: "r",
      outputId: "out_gun",
      snapshot: snap,
      position: [0, 0, 0],
      yaw: 0,
    });
    sim.input(fire([0, 1.5, 0], [0, 0, -1]));
    sim.step(1 / 60);
    const sounds = sim.drainSounds();
    expect(sounds).toEqual([{ asset: clip, position: [0, 1.1, -1.5], volume: 0.5 }]);
    expect(sim.drainSounds()).toEqual([]);
  });
});
