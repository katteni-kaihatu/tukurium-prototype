import type { Vec3 } from "@tukurium/eks";
import {
  BUILTIN,
  emptyProject,
  gunAndTargetSample,
  gunSample,
  type ProjectSnapshot,
  targetRangeSample,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";
import { inputWithTools } from "./testInput";
import { worldTransform } from "./transform";

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
  s.world.get(`r1/${target}`, s.stateIdOf("r1", "ks_target") ?? "")?.f_hp;
const ammo = (s: Simulation) =>
  s.world.get("g1/ent_gun", s.stateIdOf("g1", "ks_gun") ?? "")?.f_ammo;

describe("セッションの世界（複数の配置）", () => {
  it("ホストを引き継いでも生成物が動き、配置のリセット・削除で片付く (#64)", async () => {
    const snapshot = emptyProject("counter");
    snapshot.kokostates = [
      {
        id: "counter",
        name: "Counter",
        fields: [{ id: "n", name: "n", type: "number", default: 0 }],
      },
    ];
    snapshot.systems = [
      {
        id: "step",
        name: "Step",
        code: 'export default system({query:{with:["Counter"]},onInput(e,input){if(input.action==="spawn") world.spawn({name:"generated",states:{Counter:{n:0}}});},onUpdate(e){e.Counter.n+=1;}});',
      },
    ];
    snapshot.outputs = [
      { id: "out", name: "out", kind: "item", systems: [{ id: "step", enabled: true }], keep: [] },
    ];
    snapshot.entities = [
      {
        id: "original",
        name: "original",
        parent: null,
        output: "out",
        order: 0,
        states: { counter: { n: 0 } },
      },
    ];
    const part = {
      id: "p",
      realm: "source",
      outputId: "out",
      snapshot,
      position: [0, 0, 0] as Vec3,
      yaw: 0,
    };
    sim = await Simulation.createSession();
    sim.addPart(part);
    inputWithTools(sim, fire([0, 0, 0], [0, 0, -1], "spawn"));
    sim.step(1 / 60);
    const world = sim.world.snapshot();
    const names = Object.fromEntries(
      sim.world.entityIds().map((id) => [id, sim?.nameOf(id) ?? id]),
    );
    const time = sim.time;
    const ownership = sim.partEntitiesSnapshot();
    expect(world.entities).toHaveLength(3);
    sim.dispose();
    sim = await Simulation.createSession();
    sim.addPart(part);
    sim.restore(world, names, time, ownership);
    sim.step(1 / 60);
    const stateId = sim.stateIdOf("p", "counter") ?? "";
    expect(
      sim.world.query({ with: [stateId] }).map((id) => sim?.world.get(id, stateId)?.n),
    ).toEqual([2, 2]);
    sim.removePart("p");
    expect(sim.world.entityIds()).toEqual([]);
    sim.addPart(part);
    sim.restore(world, names, time, ownership);
    sim.resetPart("p");
    expect(sim.world.entityIds()).toEqual(["p/__root", "p/original"]);
    sim.removePart("p");
    expect(sim.world.entityIds()).toEqual([]);
  });
  it("同じ出力の全配置へ適用し、別の出力と維持マークを保つ (#63)", async () => {
    const snapshot = emptyProject("counter");
    snapshot.kokostates = [
      {
        id: "counter",
        name: "Counter",
        fields: [{ id: "n", name: "n", type: "number", default: 0 }],
      },
    ];
    snapshot.systems = [
      {
        id: "step",
        name: "Step",
        code: 'export default system({query:{with:["Counter"]},onUpdate(e){e.Counter.n += 1;}});',
      },
    ];
    snapshot.outputs = ["a", "b"].map((id) => ({
      id,
      name: id,
      kind: "item",
      systems: [{ id: "step", enabled: true }],
      keep: [{ entity: id, koko: "counter", field: "n" }],
    }));
    snapshot.entities = ["a", "b"].map((id) => ({
      id,
      name: id,
      parent: null,
      output: id,
      order: 0,
      states: { counter: { n: 0 } },
    }));
    sim = await Simulation.createSession();
    const placements = [
      ["a1", "a"],
      ["a2", "a"],
      ["b1", "b"],
    ] as const;
    for (const [id, outputId] of placements)
      sim.addPart({ id, outputId, realm: "source", snapshot, position: [0, 0, 0], yaw: 0 });
    const counts = () =>
      placements.map(
        ([id, entity]) => sim?.world.get(`${id}/${entity}`, sim.stateIdOf(id, "counter") ?? "")?.n,
      );
    sim.step(1 / 60);
    const next = structuredClone(snapshot);
    const system = next.systems[0];
    if (!system) throw new Error("Systemがありません");
    system.code = system.code.replace("+= 1", "+= 2");
    expect(sim.applyPart("source", "a", next).instances).toBe(2);
    sim.step(1 / 60);
    expect(counts()).toEqual([3, 3, 2]);
    // すでに同じ版で動くaのSystemも、bへの適用で取り除かない。
    sim.applyPart("source", "b", next);
    sim.step(1 / 60);
    expect(counts()).toEqual([5, 5, 4]);
    expect(sim.systemStatus().every((s) => s.enabled && s.error === null)).toBe(true);
  });
  it("別のリポジトリの銃で、別のリポジトリの的を撃てる。配置の位置が反映される", async () => {
    const logs: LogEntry[] = [];
    const s = await session(logs);
    // 的の位置は制作データのまま。配置の -2 は動作上の親が持つ
    expect(s.world.get("r1/ent_target2", BUILTIN.Transform)?.position).toEqual([0, 1.5, -5]);
    expect(worldTransform(s.world, "r1/ent_target2").position.toArray()).toEqual([0, 1.5, -7]);
    inputWithTools(s, fire([0, 1.5, 0], [0, 0, -1]));
    s.step(1 / 60);
    expect(ammo(s)).toBe(11);
    expect(hp(s, "ent_target2")).toBe(2);
    expect(s.nameOf("r1/ent_target2")).toBe("的2");
    expect(
      s
        .materials()
        .map((m) => m.id)
        .sort(),
    ).toEqual([s.stateIdOf("g1", "mat_gun"), s.stateIdOf("r1", "mat_wood")]);
    // マテリアルの ID も、版付きの realm ごとに付け替わる
    expect(s.world.get("g1/ent_gun", BUILTIN.Mesh)?.material).toMatch(
      /^repoGun@[0-9a-f]{8}:mat_gun$/,
    );
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
    inputWithTools(s, fire([5, 1.5, 0], [0, 0, -1]));
    s.step(1 / 60);
    expect(s.world.get("r2/ent_target2", s.stateIdOf("r2", "ks_target") ?? "")?.f_hp).toBe(2);
    expect(hp(s, "ent_target2")).toBe(3);
  });

  it("適用：マークしたフィールド（残弾）は実行値を保ち、ほかは新しい値・新しいコードになる", async () => {
    const s = await session();
    inputWithTools(s, fire([0, 1.5, 0], [0, 0, -1]));
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
    expect(s.world.get("g1/ent_gun", s.stateIdOf("g1", "ks_gun") ?? "")?.f_damage).toBe(3); // マークなし：新しい値

    for (let i = 0; i < 15; i++) s.step(1 / 60);
    inputWithTools(s, fire([0, 1.5, 0], [0, 0, -1]));
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
    inputWithTools(s, fire([0, 1.5, 0], [0, 0, -1]));
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
    expect(s.world.get("x1/e", s.stateIdOf("x1", "ks_gun") ?? "")?.f_x).toBe(8);
    // 銃のリポジトリの Gun には触れていない
    expect(s.world.get("g1/ent_gun", s.stateIdOf("g1", "ks_gun") ?? "")?.f_ammo).toBe(12);
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
    inputWithTools(sim, fire([0, 1.5, 0], [0, 0, -1]));
    sim.step(1 / 60);
    const sounds = sim.drainSounds();
    expect(sounds).toEqual([{ asset: clip, position: [0, 1.1, 3.6], volume: 0.5 }]);
    expect(sim.drainSounds()).toEqual([]);
  });
});

describe("版ごとの realm（ADR 0010 §4）", () => {
  it("同じワークスペースの一つの出力だけを適用しても、ほかの出力は古い版のまま動く（版が混ざらない）", async () => {
    const { gunAndTargetSample } = await import("@tukurium/repo-model");
    const v1 = gunAndTargetSample();
    v1.outputs = [
      {
        id: "out_gun",
        name: "銃",
        kind: "item",
        systems: [{ id: "sys_shoot", enabled: true }],
        keep: [],
      },
      {
        id: "out_range",
        name: "射撃場",
        kind: "item",
        systems: [{ id: "sys_target", enabled: true }],
        keep: [],
      },
    ];
    v1.entities = v1.entities.map((e) => ({
      ...e,
      output: e.name === "銃" ? "out_gun" : "out_range",
    }));
    sim = await Simulation.createSession();
    sim.addPart({
      id: "g",
      realm: "ws",
      outputId: "out_gun",
      snapshot: v1,
      position: [0, 0, 0],
      yaw: 0,
    });
    sim.addPart({
      id: "r",
      realm: "ws",
      outputId: "out_range",
      snapshot: v1,
      position: [0, 0, -2],
      yaw: 0,
    });

    // v2：的の hp フィールドの名前を変える（射撃場はまだ v1 のコード e.Target.hp のまま）
    const v2 = structuredClone(v1);
    v2.kokostates = v2.kokostates.map((k) =>
      k.id === "ks_target"
        ? { ...k, fields: k.fields.map((f) => (f.id === "f_hp" ? { ...f, name: "health" } : f)) }
        : k,
    );
    sim.applyPart("ws", "out_gun", v2);

    // 射撃場の的は v1 のまま：撃たれると hp が減る（v2 の定義が混ざると e.Target.hp が無くなる）
    inputWithTools(sim, fire([0, 1.5, 0], [0, 0, -1]));
    sim.step(1 / 60);
    const status = sim.systemStatus().find((x) => x.name === "TargetHit");
    expect(status?.error).toBeNull();
    const target = sim.world
      .entityIds()
      .find((id) => id.startsWith("r/") && sim?.nameOf(id) === "的2");
    const koko = target
      ? sim.world.statesOf(target).find((k) => k.endsWith(":ks_target"))
      : undefined;
    expect(target && koko ? sim.world.get(target, koko)?.f_hp : null).toBe(2);
  });
});

describe("セッション：適用しても、装備は手に持ったまま（ADR 0053）", () => {
  it("装備している道具は、新しい版に作り直しても装備したまま", async () => {
    sim = await Simulation.createSession();
    sim.addPart({
      id: "p1",
      realm: "r",
      outputId: "out_range",
      snapshot: gunAndTargetSample(),
      position: [0, 0, 0],
      yaw: 0,
    });
    sim.step(1 / 60);
    const tool = sim.world.get("p1/ent_gun", BUILTIN.EquipmentTool);
    if (tool) tool.player = "p";
    sim.applyPart("r", "out_range", gunAndTargetSample());
    sim.step(1 / 60);
    expect(sim.world.get("p1/ent_gun", BUILTIN.EquipmentTool)?.player).toBe("p");
    // リセットは作り直すだけ（装備も外れる）
    sim.resetPart("p1");
    expect(sim.world.get("p1/ent_gun", BUILTIN.EquipmentTool)?.player).toBe("");
  });
});
