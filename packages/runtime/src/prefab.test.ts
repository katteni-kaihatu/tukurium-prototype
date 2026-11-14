import { FIELD_TYPE } from "@tukurium/eks";
import {
  BUILTIN,
  emptyProject,
  expandedEntityId,
  expandPrefabForEdit,
  fromFiles,
  ProjectDoc,
  toFiles,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorld } from "./buildWorld";
import { Simulation } from "./simulation";
import { worldTransform } from "./transform";

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

const OUT = "out_main";
const STEP = `import Counter from "./Counter.koko";
export default system({
  query: { with: [Counter] },
  onUpdate(e) { e.get(Counter).n += 1; },
});
`;

/** 的のプレハブ（数える System つき）と、そのインスタンスを 3 つ置いたアウトプット */
function project() {
  const doc = new ProjectDoc();
  doc.load(emptyProject("的当て"));
  const counter = doc.addKokoState("Counter");
  doc.updateKokoState({
    id: counter,
    name: "Counter",
    fields: [
      { id: "n", name: "n", type: FIELD_TYPE.number, default: 0 },
      { id: "to", name: "to", type: FIELD_TYPE.entity, default: undefined },
    ],
  });
  const step = doc.addSystem("Step", STEP);
  const prefab = doc.addPrefab("的");
  const def = doc.prefab(prefab);
  if (!def) throw new Error("プレハブがありません");
  doc.addState(def.root, counter, { n: 0 });
  const core = doc.addPrefabEntity({
    prefab,
    name: "芯",
    states: { [BUILTIN.Transform]: { position: [0, 1, 0] }, [counter]: { n: 100, to: def.root } },
  });
  doc.updatePrefab({
    ...def,
    systems: [{ id: step, enabled: true }],
    keep: [{ entity: def.root, koko: counter, field: "n" }],
  });
  const instances = [0, 1, 2].map((i) =>
    doc.addInstance({ output: OUT, prefab, id: `ent_t${i}`, position: [i * 2, 0, 0] }),
  );
  return { doc, prefab, root: def.root, core, counter, step, instances };
}

describe("プレハブのインスタンスの再生（ADR 0076）", () => {
  it("3 つのインスタンスが、プレハブの System で動く", async () => {
    const { doc, core, counter, step, instances } = project();
    sim = await Simulation.create(doc.snapshot(), OUT, { realm: "ws" });
    expect(sim.systemStatus().map((s) => [s.id, s.enabled, s.error])).toEqual([[step, true, null]]);
    sim.step(1 / 60);
    sim.step(1 / 60);
    for (const [i, id] of instances.entries()) {
      expect(sim.world.get(id, counter)?.n).toBe(2);
      const coreId = expandedEntityId(id, core);
      expect(sim.world.get(coreId, counter)).toMatchObject({ n: 102, to: id });
      expect(sim.world.parentOf(coreId)).toBe(id);
      // 場所はインスタンスごと。中の Entity は、インスタンスからのずれ
      expect(worldTransform(sim.world, coreId).position.toArray()).toEqual([i * 2, 1, 0]);
      expect(sim.nameOf(coreId)).toBe("芯");
    }
  });

  it("保存したファイル（リリース）から読んでも、同じように動く", async () => {
    const { doc, core, counter, instances } = project();
    sim = await Simulation.create(fromFiles(toFiles(doc.snapshot())), OUT, { realm: "ws" });
    sim.step(1 / 60);
    for (const id of instances)
      expect(sim.world.get(expandedEntityId(id, core), counter)?.n).toBe(101);
  });

  it("Edit の表示（buildWorld）も、展開した並びになる", () => {
    const { doc, core, instances } = project();
    const { world, names } = buildWorld(doc.snapshot(), OUT, doc.registry());
    expect(world.entityIds().sort()).toEqual(
      instances.flatMap((id) => [id, expandedEntityId(id, core)]).sort(),
    );
    expect(names.get(expandedEntityId(instances[0] ?? "", core))).toBe("芯");
  });

  it("プレハブを開いたときの表示：編集用の並びから、プレハブの中身だけの World を組み立てる", () => {
    const { doc, prefab, root, core, counter } = project();
    const view = expandPrefabForEdit(doc.snapshot(), prefab);
    if (!view) throw new Error("プレハブがありません");
    const { world, names } = buildWorld(view, prefab);
    // 中の Entity は、そのままの ID。インスタンスは入らない
    expect(world.entityIds().sort()).toEqual([root, core].sort());
    expect(world.parentOf(core)).toBe(root);
    expect(world.parentOf(root)).toBeNull();
    expect(names.get(core)).toBe("芯");
    // 参照は、プレハブの中の ID のまま
    expect(world.get(core, counter)?.to).toBe(root);
    expect(worldTransform(world, core).position.toArray()).toEqual([0, 1, 0]);
  });

  it("セッションの配置でも動き、プレハブの変更は「適用」で届く", async () => {
    const { doc, core, counter, instances } = project();
    sim = await Simulation.createSession();
    sim.addPart({
      id: "p1",
      realm: "repo",
      outputId: OUT,
      snapshot: doc.snapshot(),
      position: [0, 0, -3],
      yaw: 0,
    });
    let koko = sim.stateIdOf("p1", counter) ?? "";
    const eid = (id: string) => `p1/${id}`;
    sim.step(1 / 60);
    for (const id of instances) {
      expect(sim.world.get(eid(id), koko)?.n).toBe(1);
      // 中の Entity の参照は、この配置の中のインスタンスを指す
      expect(sim.world.get(eid(expandedEntityId(id, core)), koko)).toMatchObject({
        n: 101,
        to: eid(id),
      });
    }
    // プレハブを直す：芯の数を 500 から始める。ワークスペースを変えただけでは、配置には届かない
    doc.setField(core, counter, "n", 500);
    sim.step(1 / 60);
    expect(sim.world.get(eid(expandedEntityId(instances[0] ?? "", core)), koko)?.n).toBe(102);
    // 適用：プレハブの中で付けた「維持」の印（いちばん上の n）は、いまの値を引き継ぐ
    const report = sim.applyPart("repo", OUT, doc.snapshot());
    expect(report).toEqual({ instances: 1, kept: 3, dropped: 0 });
    // 適用すると版が変わり、KokoState の実行時の ID も変わる
    koko = sim.stateIdOf("p1", counter) ?? "";
    for (const id of instances) {
      expect(sim.world.get(eid(id), koko)?.n).toBe(2);
      expect(sim.world.get(eid(expandedEntityId(id, core)), koko)?.n).toBe(500);
    }
    sim.step(1 / 60);
    expect(sim.world.get(eid(instances[0] ?? ""), koko)?.n).toBe(3);
    expect(sim.systemStatus().every((s) => s.enabled && s.error === null)).toBe(true);
  });

  it("インスタンスで変えた所・足したものも再生に届く。適用するとほかのインスタンスも同じに動き、ふつうの Entity に戻したものは追わない", async () => {
    const { doc, core, counter, step, instances } = project();
    const [a, b, c] = instances as [string, string, string];
    const coreOf = (id: string) => expandedEntityId(id, core);
    // a だけ：芯の値を変え、子の Entity と System を足す
    doc.setField(coreOf(a), counter, "n", 500);
    const added = doc.addEntity({
      output: OUT,
      name: "足した子",
      parent: coreOf(a),
      states: { [counter]: { n: 1000 } },
    });
    const more = doc.addSystem("More", STEP.replace("+= 1", "+= 10"));
    doc.setInstanceSystems(a, [{ id: more, enabled: true }]);
    sim = await Simulation.create(doc.snapshot(), OUT, { realm: "ws" });
    // 足した System は、プレハブの System のあとに、アウトプットの System として動く
    expect(sim.systemStatus().map((s) => s.id)).toEqual([step, more]);
    sim.step(1 / 60);
    expect(sim.world.get(coreOf(a), counter)?.n).toBe(511);
    expect(sim.world.get(coreOf(b), counter)?.n).toBe(111);
    expect(sim.world.get(added, counter)?.n).toBe(1011);
    expect(sim.world.parentOf(added)).toBe(coreOf(a));
    sim.dispose();

    // プレハブに適用する：b と c も、a と同じ値・同じ子で動く
    const plan = doc.applyPrefabInstance(a);
    const child = plan.ids[added] ?? "";
    sim = await Simulation.create(doc.snapshot(), OUT, { realm: "ws" });
    sim.step(1 / 60);
    for (const id of [a, b, c]) {
      expect(sim.world.get(coreOf(id), counter)?.n).toBe(511);
      expect(sim.world.get(expandedEntityId(id, child), counter)?.n).toBe(1011);
      expect(sim.world.parentOf(expandedEntityId(id, child))).toBe(coreOf(id));
    }
    sim.dispose();

    // c をふつうの Entity に戻す：そのあとプレハブを直しても、c には届かない
    const unpacked = doc.unpackPrefabInstance(c);
    doc.setField(core, counter, "n", 7);
    sim = await Simulation.create(doc.snapshot(), OUT, { realm: "ws" });
    sim.step(1 / 60);
    expect(sim.world.get(coreOf(b), counter)?.n).toBe(18);
    expect(sim.world.get(unpacked.ids[core] ?? "", counter)?.n).toBe(511);
    expect(sim.systemStatus().every((s) => s.enabled && s.error === null)).toBe(true);
  });
});

describe("アウトプットの Entity からプレハブを作る（ADR 0076）", () => {
  /** 的（芯つき）と、芯を指す「ほか」。数える System は、アウトプットで動かす */
  function scene() {
    const doc = new ProjectDoc();
    doc.load(emptyProject("的当て"));
    const counter = doc.addKokoState("Counter");
    doc.updateKokoState({
      id: counter,
      name: "Counter",
      fields: [
        { id: "n", name: "n", type: FIELD_TYPE.number, default: 0 },
        { id: "to", name: "to", type: FIELD_TYPE.entity, default: undefined },
      ],
    });
    const step = doc.addSystem("Step", STEP);
    const target = doc.addEntity({
      output: OUT,
      name: "的",
      id: "ent_mato",
      states: {
        [BUILTIN.Transform]: { position: [4, 0, 0], scale: [2, 2, 2] },
        [counter]: { n: 0, to: "ent_shin" },
      },
    });
    const core = doc.addEntity({
      output: OUT,
      name: "芯",
      id: "ent_shin",
      parent: target,
      states: { [BUILTIN.Transform]: { position: [0, 1, 0] }, [counter]: { n: 100, to: target } },
    });
    const other = doc.addEntity({
      output: OUT,
      name: "ほか",
      id: "ent_hoka",
      states: { [counter]: { n: 1000, to: core } },
    });
    const output = doc.output(OUT);
    if (!output) throw new Error("アウトプットがありません");
    doc.updateOutput({ ...output, systems: [{ id: step, enabled: true }] });
    return { doc, counter, step, target, core, other };
  }

  /** 2 回進めたあとの、Entity ごとの値・親・場所 */
  async function played(doc: ProjectDoc, counter: string, ids: readonly string[]) {
    const run = await Simulation.create(doc.snapshot(), OUT, { realm: "ws" });
    try {
      run.step(1 / 60);
      run.step(1 / 60);
      return {
        systems: run.systemStatus().map((s) => [s.id, s.enabled, s.error]),
        count: run.world.entityIds().length,
        entities: ids.map((id) => ({
          name: run.nameOf(id),
          state: run.world.get(id, counter),
          parent: run.world.parentOf(id),
          position: worldTransform(run.world, id).position.toArray(),
        })),
      };
    } finally {
      run.dispose();
    }
  }

  it("変換の前とあとで、再生すると同じように動く（ID の対応を通して比べる）", async () => {
    const { doc, counter, step, target, core, other } = scene();
    const before = await played(doc, counter, [target, core, other]);
    const plan = doc.makePrefabFromEntity(target, { systems: [step] });
    const at = new Map(plan.moved.map((m) => [m.from, m.expanded]));
    const coreNow = at.get(core) ?? "";
    expect(coreNow).toBe(expandedEntityId(target, plan.moved[1]?.to ?? ""));
    const after = await played(doc, counter, [target, coreNow, other]);
    // 芯の ID だけが変わる。値・親・場所・動く System は同じ
    const renamed = JSON.parse(JSON.stringify(before).replaceAll(`"${core}"`, `"${coreNow}"`));
    expect(after).toEqual(renamed);
    expect(after.entities.map((e) => e.state?.n)).toEqual([2, 102, 1002]);
    expect(after.entities[2]?.state?.to).toBe(coreNow);
    expect(after.entities[1]?.position).toEqual([4, 2, 0]);
  });

  it("変換したプレハブのインスタンスをもう一つ置くと、同じ中身が、プレハブの System で動く", async () => {
    const { doc, counter, step, target } = scene();
    const plan = doc.makePrefabFromEntity(target, { systems: [step] });
    // 別のアウトプットに置く：System は、プレハブが持っていく
    const second = doc.addOutput("別の作品", "item");
    const inst = doc.addInstance({ output: second, prefab: plan.prefab.id, position: [0, 0, 5] });
    sim = await Simulation.create(doc.snapshot(), second, { realm: "ws" });
    expect(sim.systemStatus().map((s) => [s.id, s.enabled, s.error])).toEqual([[step, true, null]]);
    sim.step(1 / 60);
    const coreId = expandedEntityId(inst, plan.moved[1]?.to ?? "");
    expect(sim.world.get(inst, counter)).toMatchObject({ n: 1, to: coreId });
    expect(sim.world.get(coreId, counter)).toMatchObject({ n: 101, to: inst });
    // 大きさは写る（芯は、的の大きさ 2 倍の中の 1 m 上）
    expect(worldTransform(sim.world, coreId).position.toArray()).toEqual([0, 2, 5]);
  });
});
