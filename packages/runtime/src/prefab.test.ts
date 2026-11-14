import { FIELD_TYPE } from "@tukurium/eks";
import {
  BUILTIN,
  emptyProject,
  expandedEntityId,
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
});
