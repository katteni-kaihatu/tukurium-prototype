import { FIELD_TYPE } from "@tukurium/eks";
import {
  BUILTIN,
  emptyProject,
  expandedEntityId,
  expandPrefabs,
  fromFiles,
  getPrefabOverride,
  ProjectDoc,
  toFiles,
} from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { describeDiff } from "./diffView";
import { prefabChangeParts, prefabPart } from "./prefabChanges";
import { planRevert } from "./revert";

const OUT = "out_main";

it("undefined にした上書きと、まだ上書きしていない欄を区別する", () => {
  expect(
    prefabChangeParts(undefined, {
      prefabOverrides: { child: { states: { koko: { field: undefined } } } },
    }),
  ).toMatchObject([{ path: "child", kind: "field", beforePresent: false, afterPresent: true }]);
});

/** 的のプレハブ（芯つき）と、そのインスタンスを一つ置いて保存したところ */
function setup() {
  const project = new ProjectDoc();
  project.load(emptyProject("プレハブ"));
  const prefab = project.addPrefab("的");
  const root = project.prefab(prefab)?.root ?? "";
  const core = project.addPrefabEntity({
    prefab,
    name: "芯",
    states: { [BUILTIN.Transform]: { position: [0, 1, 0] } },
  });
  const instance = project.addInstance({ output: OUT, prefab });
  // 保存したもの（ファイルを通した形）と比べる
  const head = fromFiles(toFiles(project.snapshot()));
  const diff = () => describeDiff(head, project.snapshot());
  const revert = (id: string) => {
    const plan = planRevert(project, head, id);
    if (!plan) throw new Error(`戻せない: ${id}`);
    plan();
  };
  return { project, head, prefab, root, core, instance, diff, revert };
}

describe("プレハブの差分と戻す（ADR 0076）", () => {
  it.each(["stored", "override"])("格納先が変わったフィールドも保存前の形に戻す（%s）", (kind) => {
    const { project, instance, root } = setup();
    const koko = project.addKokoState("Health");
    project.updateKokoState({
      id: koko,
      name: "Health",
      fields: [{ id: "hp", name: "hp", type: FIELD_TYPE.number, default: 3 }],
    });
    project.addState(instance, koko, { hp: 5 });
    project.addState(root, koko);
    const head = fromFiles(toFiles(project.snapshot()));
    project.setField(instance, koko, "hp", 7);
    const part = kind === "stored" ? `field:${koko}:hp` : prefabPart("", "field", koko, "hp");
    const revert = planRevert(project, head, `entity:${instance}`, part);
    expect(revert).not.toBeNull();
    revert?.();
    expect(toFiles(project.snapshot())).toEqual(toFiles(head));
    expect(describeDiff(head, project.snapshot())).toEqual([]);
  });

  it("最後のローカルフィールドを戻すと、空の上書きの印を出さない", () => {
    const { project, instance, root } = setup();
    const koko = project.addKokoState("Health");
    project.updateKokoState({
      id: koko,
      name: "Health",
      fields: [{ id: "hp", name: "hp", type: FIELD_TYPE.number, default: 3 }],
    });
    project.addState(instance, koko, { hp: 5 });
    project.addState(root, koko);
    project.revertPrefabField(instance, koko, "hp");
    expect(getPrefabOverride(project.snapshot(), instance)).toBeUndefined();
  });

  it("最後のローカルフィールドを戻しても、同じ入れ物への別フィールドの同時追加は残る", () => {
    const { project, instance, root } = setup();
    const koko = project.addKokoState("Health");
    project.updateKokoState({
      id: koko,
      name: "Health",
      fields: [
        { id: "hp", name: "hp", type: FIELD_TYPE.number, default: 3 },
        { id: "max", name: "max", type: FIELD_TYPE.number, default: 10 },
      ],
    });
    project.addState(root, koko);
    const entity = project.entity(instance);
    if (!entity) throw new Error("instance");
    project.restoreEntity({ ...entity, states: { ...entity.states, [koko]: { hp: 5 } } });
    const other = new ProjectDoc();
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(project.doc));
    const vector = Y.encodeStateVector(project.doc);
    project.revertPrefabField(instance, koko, "hp");
    other.restoreEntityField(instance, koko, "max", { ...entity, states: { [koko]: { max: 50 } } });
    const a = Y.encodeStateAsUpdate(project.doc, vector);
    const b = Y.encodeStateAsUpdate(other.doc, vector);
    Y.applyUpdate(project.doc, b);
    Y.applyUpdate(other.doc, a);
    expect(
      expandPrefabs(project.snapshot()).entities.find((e) => e.id === instance)?.states[koko],
    ).toEqual({ hp: 3, max: 50 });
    expect(project.snapshot()).toEqual(other.snapshot());
  });

  it.each([false, true])(
    "フィールドの保存戻しで、別のフィールドの同時編集を失わない（保存済み上書き=%s）",
    (savedOverride) => {
      const { project, core, instance } = setup();
      const child = expandedEntityId(instance, core);
      if (savedOverride) project.setField(child, BUILTIN.Transform, "position", [1, 2, 3]);
      const head = fromFiles(toFiles(project.snapshot()));
      project.setField(child, BUILTIN.Transform, "position", [9, 9, 9]);
      const other = new ProjectDoc();
      Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(project.doc));
      const vector = Y.encodeStateVector(project.doc);
      planRevert(
        project,
        head,
        `entity:${instance}`,
        prefabPart(core, "field", BUILTIN.Transform, "position"),
      )?.();
      other.setField(child, BUILTIN.Transform, "scale", [7, 7, 7]);
      const localUpdate = Y.encodeStateAsUpdate(project.doc, vector);
      const remoteUpdate = Y.encodeStateAsUpdate(other.doc, vector);
      Y.applyUpdate(project.doc, remoteUpdate);
      Y.applyUpdate(other.doc, localUpdate);
      const override =
        project.entity(instance)?.prefabOverrides?.[core]?.states?.[BUILTIN.Transform];
      expect(override?.scale).toEqual([7, 7, 7]);
      expect(override?.position).toEqual(savedOverride ? [1, 2, 3] : undefined);
      expect(other.snapshot()).toEqual(project.snapshot());
    },
  );

  it("子の値と名前の上書きは保存の差分に出て、一つずつ保存時の形へ戻せる", () => {
    const { project, head, core, instance, diff } = setup();
    const child = expandedEntityId(instance, core);
    project.setField(child, BUILTIN.Transform, "position", [2, 3, 4]);
    project.renameEntity(child, "変えた芯");
    const entry = diff().find((e) => e.id === `entity:${instance}`);
    const fieldPart = prefabPart(core, "field", BUILTIN.Transform, "position");
    expect(entry?.lines.some((l) => l.part === fieldPart)).toBe(true);
    const revert = planRevert(project, head, `entity:${instance}`, fieldPart);
    expect(revert).not.toBeNull();
    revert?.();
    expect(project.entity(instance)?.prefabOverrides?.[core]?.states).toBeUndefined();
    expect(project.entity(instance)?.prefabOverrides?.[core]?.name).toBe("変えた芯");
    planRevert(project, head, `entity:${instance}`, prefabPart(core, "name"))?.();
    expect(diff()).toEqual([]);
  });

  it("保存してある上書きと追加 System を個別に戻す", () => {
    const { project, core, instance } = setup();
    const child = expandedEntityId(instance, core);
    project.setField(child, BUILTIN.Transform, "position", [1, 2, 3]);
    const system = project.addSystem("動き", "");
    project.setInstanceSystems(instance, [{ id: system, enabled: true }]);
    const head = fromFiles(toFiles(project.snapshot()));
    project.setField(child, BUILTIN.Transform, "position", [9, 9, 9]);
    project.setInstanceSystems(instance, []);
    planRevert(
      project,
      head,
      `entity:${instance}`,
      prefabPart(core, "field", BUILTIN.Transform, "position"),
    )?.();
    planRevert(project, head, `entity:${instance}`, prefabPart("", "system", system))?.();
    expect(describeDiff(head, project.snapshot())).toEqual([]);
  });

  it("保存したままなら、差分は出ない", () => {
    expect(setup().diff()).toEqual([]);
  });

  it("新しいプレハブとインスタンスは、名前で出る", () => {
    const { project, diff } = setup();
    const box = project.addPrefab("箱");
    project.addInstance({ output: OUT, prefab: box, name: "箱1" });
    const entries = diff();
    expect(entries.map((e) => [e.id, e.name, e.kind])).toEqual([
      [expect.stringMatching(/^entity:/), "箱1", "added"],
      [`prefab:${box}`, "箱", "added"],
    ]);
    expect(entries[0]?.lines).toContainEqual({ label: "プレハブ", before: null, after: "箱" });
  });

  it("プレハブの中を変えると、変えた所が出て、まとめて戻せる", () => {
    const { project, prefab, core, diff, revert } = setup();
    project.renamePrefab(prefab, "まと");
    project.setField(core, BUILTIN.Transform, "position", [0, 2, 0]);
    const added = project.addPrefabEntity({ prefab, name: "飾り" });
    const [entry] = diff();
    expect(entry).toMatchObject({ id: `prefab:${prefab}`, name: "まと", kind: "modified" });
    expect(entry?.lines).toEqual([
      { label: "名前", before: "的", after: "まと", part: "name" },
      { label: "中の「芯」", before: "変える前", after: "変えた所：Transform.position" },
      { label: "中の「飾り」", before: null, after: "足した" },
    ]);
    revert(`prefab:${prefab}`);
    expect(diff()).toEqual([]);
    expect(project.prefabEntity(added)).toBeUndefined();
    expect(project.prefab(prefab)?.name).toBe("的");
  });

  it("消したプレハブは戻せる。足したプレハブは、戻すと消える", () => {
    const { project, prefab, root, core, instance, diff, revert } = setup();
    project.removePrefab(prefab);
    expect(diff().map((e) => [e.id, e.kind])).toEqual([[`prefab:${prefab}`, "removed"]]);
    revert(`prefab:${prefab}`);
    expect(diff()).toEqual([]);
    expect(
      project
        .prefabEntities(prefab)
        .map((e) => e.id)
        .sort(),
    ).toEqual([root, core].sort());
    expect(project.entity(instance)?.instanceOf).toEqual({ prefab });

    const box = project.addPrefab("箱");
    revert(`prefab:${box}`);
    expect(project.prefab(box)).toBeUndefined();
    expect(project.prefabEntities(box)).toEqual([]);
    expect(diff()).toEqual([]);
  });

  it("Entity からプレハブを作ると、Entity の変化とプレハブの追加として出て、一つずつ戻せる", () => {
    const project = new ProjectDoc();
    project.load(emptyProject("的当て"));
    const target = project.addEntity({
      output: OUT,
      name: "的",
      id: "ent_mato",
      states: { [BUILTIN.Transform]: { position: [1, 0, 0] }, [BUILTIN.Mesh]: { shape: "box" } },
    });
    const core = project.addEntity({ output: OUT, name: "芯", id: "ent_shin", parent: target });
    const head = fromFiles(toFiles(project.snapshot()));
    const plan = project.makePrefabFromEntity(target);
    const entries = describeDiff(head, project.snapshot());
    expect(entries.map((e) => [e.id, e.name, e.kind]).sort()).toEqual([
      [`entity:${target}`, "的", "modified"],
      [`entity:${core}`, "芯", "removed"],
      [`prefab:${plan.prefab.id}`, "的", "added"],
    ]);
    expect(entries.find((e) => e.id === `entity:${target}`)?.lines).toContainEqual({
      label: "プレハブ",
      before: null,
      after: "的",
    });
    // ひとまとまりで戻す操作はない。出た項目を一つずつ戻すと、作る前の形になる
    for (const e of entries) {
      const revert = planRevert(project, head, e.id);
      if (!revert) throw new Error(`戻せない: ${e.id}`);
      revert();
    }
    expect(describeDiff(head, project.snapshot())).toEqual([]);
    expect(project.prefabs()).toEqual([]);
    expect(project.entity(core)?.parent).toBe(target);
  });
});
