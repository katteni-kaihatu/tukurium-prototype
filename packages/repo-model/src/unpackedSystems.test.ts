import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ProjectDependencyGraph } from "./dependencyGraph";
import { checkProjectReferences } from "./diagnostics/references";
import { fromFiles, toFiles } from "./files";
import { expandPrefabForEdit, expandPrefabs, PrefabExpansionCache } from "./prefab";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";
import type { EntityDef, OutputSystem, ProjectSnapshot } from "./schema";

const systems = (...ids: string[]): OutputSystem[] => ids.map((id) => ({ id, enabled: true }));
const entity = (id: string, parent: string | null = null): EntityDef => ({
  id,
  name: id,
  output: "out_main",
  parent,
  order: 0,
  states: {},
});

function nested(): ProjectSnapshot {
  return {
    ...emptyProject("System の順"),
    prefabs: [
      { id: "outer", name: "外", root: "outerRoot", systems: systems("before"), keep: [] },
      { id: "inner", name: "中", root: "innerRoot", systems: systems("inside"), keep: [] },
    ],
    prefabEntities: [
      { id: "outerRoot", name: "外", prefab: "outer", parent: null, order: 0, states: {} },
      {
        id: "nested",
        name: "中",
        prefab: "outer",
        parent: "outerRoot",
        order: 0,
        states: {},
        instanceOf: { prefab: "inner" },
        instanceSystems: systems("nestedAdded"),
      },
      { id: "innerRoot", name: "中", prefab: "inner", parent: null, order: 0, states: {} },
    ],
    entities: [
      { ...entity("instance"), instanceOf: { prefab: "outer" }, instanceSystems: systems("after") },
    ],
  };
}

describe("解除した Entity に残した System", () => {
  it("解除前後の順を保ち、子のプレハブの追加・入切に追随する", () => {
    const snap = nested();
    const cache = new PrefabExpansionCache();
    const before = expandPrefabs(snap, { cache }).outputs[0]?.systems;
    snap.entities = [
      {
        ...entity("instance"),
        unpackedSystems: systems("before"),
        instanceSystems: systems("after"),
      },
      {
        ...entity("nestedCopy", "instance"),
        instanceOf: { prefab: "inner" },
        instanceSystems: systems("nestedAdded"),
      },
    ];
    expect(expandPrefabs(snap, { cache }).outputs[0]?.systems).toEqual(before);
    const inner = snap.prefabs?.find((p) => p.id === "inner");
    if (!inner) throw new Error("inner");
    inner.systems = [{ id: "inside", enabled: false }, ...systems("newInside")];
    expect(expandPrefabs(snap, { cache }).outputs[0]?.systems).toEqual([
      ...systems("before"),
      { id: "inside", enabled: false },
      ...systems("newInside", "nestedAdded", "after"),
    ]);
    // 子以外のインスタンスが「入」なら OR、アウトプットにあればそちらの設定が勝つ。
    snap.entities.push({ ...entity("another"), order: 1, instanceOf: { prefab: "inner" } });
    snap.entities[0]?.unpackedSystems?.push({ id: "inside", enabled: true });
    expect(expandPrefabs(snap).outputs[0]?.systems.find((s) => s.id === "inside")?.enabled).toBe(
      true,
    );
    const output = snap.outputs[0];
    if (!output) throw new Error("output");
    output.systems = [{ id: "inside", enabled: false }];
    expect(expandPrefabs(snap).outputs[0]?.systems[0]).toEqual({ id: "inside", enabled: false });
  });

  it("プレハブが残っていなくても子の前後を集約し、もう一度展開しても変わらない", () => {
    const snap = emptyProject("解除済み");
    snap.entities = [
      { ...entity("root"), unpackedSystems: systems("a"), instanceSystems: systems("d") },
      { ...entity("child", "root"), unpackedSystems: systems("b"), instanceSystems: systems("c") },
    ];
    const expanded = expandPrefabs(snap);
    expect(expanded.outputs[0]?.systems).toEqual(systems("a", "b", "c", "d"));
    expect(expanded.entities.every((e) => !e.unpackedSystems && !e.instanceSystems)).toBe(true);
    expect(expandPrefabs(expanded)).toBe(expanded);
  });

  it("プレハブの中の解除済み Entity も、編集と配置で同じ順に動く", () => {
    const snap = nested();
    const root = snap.prefabEntities?.find((e) => e.id === "outerRoot");
    if (!root) throw new Error("root");
    root.unpackedSystems = systems("formerOuter");
    root.instanceSystems = systems("formerAdded");
    expect(expandPrefabs(snap).outputs[0]?.systems).toEqual(
      systems("before", "formerOuter", "inside", "nestedAdded", "formerAdded", "after"),
    );
    expect(expandPrefabForEdit(snap, "outer")?.outputs[0]?.systems).toEqual(
      systems("before", "formerOuter", "inside", "nestedAdded", "formerAdded"),
    );
  });

  it("保存・共同編集・複製で残し、依存と問題を調べ、System 削除では両方から外す", () => {
    const snap = emptyProject("保存");
    snap.systems = [{ id: "known", name: "既存", code: "" }];
    snap.entities = [
      {
        ...entity("root"),
        unpackedSystems: systems("known", "missing"),
        instanceSystems: systems("known"),
      },
    ];
    const doc = new ProjectDoc();
    doc.load(snap);
    const files = toFiles(doc.snapshot());
    expect(fromFiles(files).entities).toEqual(doc.snapshot().entities);
    expect(toFiles(fromFiles(files))).toEqual(files);
    const other = new ProjectDoc();
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(doc.doc));
    expect(other.entity("root")).toEqual(doc.entity("root"));
    const copy = doc.duplicateEntity("root", false);
    expect(doc.entity(copy ?? "")?.unpackedSystems).toEqual(systems("known", "missing"));
    expect(doc.entity(copy ?? "")?.instanceSystems).toEqual(systems("known"));
    expect(
      ProjectDependencyGraph.fromSnapshot(doc.snapshot()).dependenciesOf({
        kind: "entity",
        id: "root",
      }),
    ).toEqual(
      expect.arrayContaining([
        { kind: "system", id: "known" },
        { kind: "system", id: "missing" },
      ]),
    );
    expect(checkProjectReferences(doc.snapshot()).filter((d) => d.subject.id === "root")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: { kind: "property", path: ["unpackedSystems", "missing"] },
        }),
      ]),
    );
    doc.removeSystem("known");
    expect(doc.entity("root")?.unpackedSystems).toEqual(systems("missing"));
    expect(doc.entity("root")?.instanceSystems).toBeUndefined();
  });

  it("もう一度プレハブにするとき、ルートと子の System をプレハブへ移す", () => {
    const snap = nested();
    snap.entities = [
      { ...entity("root"), unpackedSystems: systems("before"), instanceSystems: systems("after") },
      {
        ...entity("child", "root"),
        instanceOf: { prefab: "inner" },
        instanceSystems: systems("childAdded"),
        prefabOverrides: { "": { name: "子での変更" } },
      },
    ];
    const doc = new ProjectDoc();
    doc.load(snap);
    const before = expandPrefabs(doc.snapshot()).outputs[0]?.systems;
    const plan = doc.makePrefabFromEntity("root");
    const root = doc.prefabEntity(plan.prefab.root);
    expect(root?.unpackedSystems).toEqual(systems("before"));
    expect(root?.instanceSystems).toEqual(systems("after"));
    const movedChild = plan.prefabEntities.find((e) => e.instanceOf);
    expect(movedChild?.instanceSystems).toEqual(systems("childAdded"));
    expect(movedChild?.prefabOverrides).toEqual({ "": { name: "子での変更" } });
    expect(doc.entity("root")?.unpackedSystems).toBeUndefined();
    expect(doc.entity("root")?.instanceSystems).toBeUndefined();
    expect(expandPrefabs(doc.snapshot()).outputs[0]?.systems).toEqual(before);
  });
});
