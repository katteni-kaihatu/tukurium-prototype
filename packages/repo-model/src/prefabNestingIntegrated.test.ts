import { FIELD_TYPE } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BUILTIN } from "./builtins";
import { fromFiles, toFiles } from "./files";
import { expandPrefabForEdit, expandPrefabs, getPrefabOverride } from "./prefab";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";

const OUT = "out_main";

function setup() {
  const doc = new ProjectDoc();
  doc.load(emptyProject("入れ子の編集"));
  const state = doc.addKokoState("State");
  doc.updateKokoState({
    id: state,
    name: "State",
    fields: [
      { id: "value", name: "value", type: FIELD_TYPE.number, default: 1 },
      { id: "to", name: "to", type: FIELD_TYPE.entity, default: undefined },
    ],
  });
  const piece = doc.addPrefab("駒");
  const leaf = doc.addPrefabEntity({ prefab: piece, name: "駒の中", states: { [state]: {} } });
  const board = doc.addPrefab("盤");
  const slot = doc.addInstance({ ownerPrefab: board, prefab: piece });
  const first = doc.addInstance({ output: OUT, prefab: board });
  const second = doc.addInstance({ output: OUT, prefab: board });
  const at = (id: string) => expandPrefabs(doc.snapshot()).entities.find((e) => e.id === id);
  return { doc, state, piece, leaf, board, slot, first, second, at };
}

describe("入れ子の上書き・適用・解除", () => {
  it("内側の上書きに外側を重ね、それぞれの変更だけを戻せる", () => {
    const { doc, state, leaf, slot, first, second, at } = setup();
    doc.setField(`${slot}/${leaf}`, state, "value", 6);
    doc.setField(`${first}/${slot}/${leaf}`, state, "value", 9);
    doc.setField(leaf, state, "value", 3);
    expect(at(`${first}/${slot}/${leaf}`)?.states[state]?.value).toBe(9);
    expect(at(`${second}/${slot}/${leaf}`)?.states[state]?.value).toBe(6);
    expect(getPrefabOverride(doc.snapshot(), `${first}/${slot}/${leaf}`)).toBeDefined();
    doc.revertPrefabField(`${first}/${slot}/${leaf}`, state, "value");
    expect(at(`${first}/${slot}/${leaf}`)?.states[state]?.value).toBe(6);
    expect(getPrefabOverride(doc.snapshot(), `${first}/${slot}/${leaf}`)).toBeUndefined();
    doc.revertPrefabField(`${slot}/${leaf}`, state, "value");
    expect(at(`${first}/${slot}/${leaf}`)?.states[state]?.value).toBe(3);
    expect(at(`${second}/${slot}/${leaf}`)?.states[state]?.value).toBe(3);
  });

  it("外側を適用しても内側のプレハブは変えず、内側を適用したときだけ変える", () => {
    const { doc, state, leaf, slot, first, second, at } = setup();
    doc.setField(`${first}/${slot}/${leaf}`, state, "value", 8);
    doc.applyPrefabInstance(first);
    expect(doc.prefabEntity(leaf)?.states[state]?.value).toBe(1);
    expect(doc.prefabEntity(slot)?.prefabOverrides?.[leaf]?.states?.[state]?.value).toBe(8);
    expect(at(`${second}/${slot}/${leaf}`)?.states[state]?.value).toBe(8);
    doc.applyPrefabInstance(slot);
    expect(doc.prefabEntity(leaf)?.states[state]?.value).toBe(8);
    expect(doc.prefabEntity(slot)?.prefabOverrides).toBeUndefined();
    expect(at(`${second}/${slot}/${leaf}`)?.states[state]?.value).toBe(8);
  });

  it("外側だけ解除したあとも、内側の上書きと変更への追随を保つ", () => {
    const { doc, state, piece, leaf, slot, first } = setup();
    doc.setField(`${first}/${slot}/${leaf}`, state, "value", 8);
    const unpacked = doc.unpackPrefabInstance(first);
    const nested = unpacked.ids[slot] ?? "";
    expect(doc.entity(first)?.instanceOf).toBeUndefined();
    expect(doc.entity(nested)?.instanceOf).toEqual({ prefab: piece });
    expect(doc.entity(nested)?.prefabOverrides?.[leaf]?.states?.[state]?.value).toBe(8);
    doc.revertPrefabField(`${nested}/${leaf}`, state, "value");
    doc.setField(leaf, state, "value", 4);
    expect(
      expandPrefabs(doc.snapshot()).entities.find((e) => e.id === `${nested}/${leaf}`)?.states[
        state
      ]?.value,
    ).toBe(4);
  });
});

describe("プレハブの中の変換で追加情報を保つ", () => {
  it("入れ子の子を移すまとまりの外へ付け替えているときは、変換を理由付きで断る", () => {
    const { doc, board, slot, leaf, first } = setup();
    const group = doc.addPrefabEntity({ prefab: board, name: "まとめる" });
    const outside = doc.addPrefabEntity({ prefab: board, name: "外の兄弟" });
    doc.setParent(slot, group);
    doc.setParent(`${slot}/${leaf}`, outside);
    const before = doc.snapshot();
    expect(
      expandPrefabs(before).entities.find((e) => e.id === `${first}/${slot}/${leaf}`)?.parent,
    ).toBe(`${first}/${outside}`);
    const result = doc.planPrefabFromEntity(group);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("駒の中");
      expect(result.reason).toContain("外の兄弟");
      expect(result.reason).toContain("まとまりの外");
    }
    expect(() => doc.makePrefabFromEntity(group)).toThrow(/まとまりの外/);
    expect(doc.snapshot()).toEqual(before);
  });

  it("入れ子の中に足した Entity も、親と参照を保って移す", () => {
    const { doc, state, board, slot, leaf, first } = setup();
    const group = doc.addPrefabEntity({ prefab: board, name: "まとめる" });
    doc.setParent(slot, group);
    const added = doc.addPrefabEntity({
      prefab: board,
      name: "入れ子に足した",
      parent: `${slot}/${leaf}`,
      states: { [state]: { to: `${slot}/${leaf}` } },
    });
    const child = doc.addPrefabEntity({ prefab: board, name: "追加の子", parent: added });
    const outside = doc.addEntity({
      output: OUT,
      name: "外から参照",
      states: { [state]: { to: `${first}/${added}` } },
    });
    const plan = doc.makePrefabFromEntity(group);
    const ids = new Map(plan.moved.map((m) => [m.from, m.to]));
    const newSlot = ids.get(slot) ?? "";
    const newAdded = ids.get(added) ?? "";
    expect(doc.prefabEntity(newAdded)).toMatchObject({
      parent: `${newSlot}/${leaf}`,
      states: { [state]: { to: `${newSlot}/${leaf}` } },
    });
    expect(doc.prefabEntity(ids.get(child) ?? "")?.parent).toBe(newAdded);
    expect(doc.entity(outside)?.states[state]?.to).toBe(`${first}/${group}/${newAdded}`);
    expect(
      expandPrefabs(doc.snapshot()).entities.find((e) => e.id === `${first}/${group}/${newAdded}`)
        ?.parent,
    ).toBe(`${first}/${group}/${newSlot}/${leaf}`);
  });

  it("変換による維持の移動と、持ち主の名前への同時編集を両方保つ", () => {
    const { doc, state, board } = setup();
    const group = doc.addPrefabEntity({ prefab: board, name: "まとめる", states: { [state]: {} } });
    const definition = doc.prefab(board);
    if (!definition) throw new Error("fixture");
    doc.updatePrefab({ ...definition, keep: [{ entity: group, koko: state, field: "value" }] });
    const remote = new ProjectDoc();
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(doc.doc));
    const vector = Y.encodeStateVector(doc.doc);
    const plan = doc.makePrefabFromEntity(group);
    remote.renamePrefab(board, "名前を変えた盤");
    const localUpdate = Y.encodeStateAsUpdate(doc.doc, vector);
    const remoteUpdate = Y.encodeStateAsUpdate(remote.doc, vector);
    Y.applyUpdate(doc.doc, remoteUpdate);
    Y.applyUpdate(remote.doc, localUpdate);
    expect(doc.prefab(board)?.name).toBe("名前を変えた盤");
    expect(doc.prefab(board)?.keep).toEqual([]);
    expect(doc.prefab(plan.prefab.id)?.keep).toEqual([
      { entity: plan.prefab.root, koko: state, field: "value" },
    ]);
    expect(remote.snapshot()).toEqual(doc.snapshot());
  });

  it("外側の上書きの対象・参照・親、内側の上書き、System、消えた親を移す", () => {
    const { doc, state, piece, leaf, board, slot, first } = setup();
    const extra = doc.addKokoState("Extra");
    doc.updateKokoState({
      id: extra,
      name: "Extra",
      fields: [{ id: "to", name: "to", type: FIELD_TYPE.entity, default: undefined }],
    });
    const beforeSystem = doc.addSystem("前", "");
    const afterSystem = doc.addSystem("後", "");
    const nestedSystem = doc.addSystem("内側", "");
    const group = doc.addPrefabEntity({
      prefab: board,
      name: "まとめる",
      states: { [BUILTIN.Transform]: {} },
    });
    const child = doc.addPrefabEntity({
      prefab: board,
      name: "子",
      parent: group,
      states: { [state]: {} },
    });
    doc.setParent(slot, group);
    doc.setField(`${slot}/${leaf}`, state, "to", child);
    doc.addState(`${slot}/${leaf}`, extra, { to: child });
    doc.setParent(`${slot}/${leaf}`, child);
    doc.setInstanceSystems(slot, [{ id: nestedSystem, enabled: true }]);
    doc.setField(`${first}/${child}`, state, "to", `${first}/${slot}/${leaf}`);
    doc.addState(`${first}/${child}`, BUILTIN.Collider, { shape: "box" });
    doc.addState(`${first}/${child}`, extra, { to: `${first}/${slot}/${leaf}` });
    doc.setParent(`${first}/${child}`, first);
    const snapshot = doc.snapshot();
    const rawGroup = snapshot.prefabEntities?.find((e) => e.id === group);
    const rawBoard = snapshot.prefabs?.find((p) => p.id === board);
    if (!rawGroup || !rawBoard) throw new Error("fixture");
    rawGroup.unpackedSystems = [{ id: beforeSystem, enabled: true }];
    rawGroup.instanceSystems = [{ id: afterSystem, enabled: true }];
    rawBoard.deletedParents = { gone: child, gone2: "gone" };
    doc.load(snapshot);
    const systemsBefore = expandPrefabs(doc.snapshot()).outputs[0]?.systems;
    const plan = doc.makePrefabFromEntity(group);
    const ids = new Map(plan.moved.map((m) => [m.from, m.to]));
    const newChild = ids.get(child) ?? "";
    const newSlot = ids.get(slot) ?? "";
    expect(doc.prefabEntity(newSlot)?.instanceOf).toEqual({ prefab: piece });
    expect(doc.prefabEntity(newSlot)?.prefabOverrides?.[leaf]).toMatchObject({
      parent: newChild,
      states: { [state]: { to: newChild } },
      addedStates: { [extra]: { to: newChild } },
    });
    expect(doc.prefabEntity(newSlot)?.instanceSystems).toEqual([
      { id: nestedSystem, enabled: true },
    ]);
    expect(doc.prefabEntity(plan.prefab.root)?.unpackedSystems).toEqual([
      { id: beforeSystem, enabled: true },
    ]);
    expect(doc.prefabEntity(plan.prefab.root)?.instanceSystems).toEqual([
      { id: afterSystem, enabled: true },
    ]);
    expect(doc.prefabEntity(group)?.unpackedSystems).toBeUndefined();
    expect(doc.entity(first)?.prefabOverrides?.[`${group}/${newChild}`]).toMatchObject({
      parent: first,
      states: { [state]: { to: `${first}/${group}/${newSlot}/${leaf}` } },
      addedStates: {
        [BUILTIN.Collider]: { shape: "box" },
        [extra]: { to: `${first}/${group}/${newSlot}/${leaf}` },
      },
    });
    expect(doc.entity(first)?.prefabOverrides?.[child]).toBeUndefined();
    expect(doc.prefab(board)?.deletedParents).toEqual({
      gone: `${group}/${newChild}`,
      gone2: "gone",
    });
    expect(doc.prefab(plan.prefab.id)?.deletedParents).toEqual({ gone: newChild, gone2: "gone" });
    expect(expandPrefabs(doc.snapshot()).outputs[0]?.systems).toEqual(systemsBefore);
    expect(plan.rewrites.some((r) => r.override)).toBe(true);
    expect(plan.structureRewrites.some((r) => r.kind === "上書きの対象")).toBe(true);
    expect(toFiles(fromFiles(toFiles(doc.snapshot())))).toEqual(toFiles(doc.snapshot()));
  });

  it("消えた親の記録は、プレハブ編集でも外側の配置でも使う", () => {
    const { doc, state, leaf, board, slot, first } = setup();
    const group = doc.addPrefabEntity({ prefab: board, name: "まとめる" });
    doc.setParent(slot, group);
    doc.setField(`${slot}/${leaf}`, state, "value", 6);
    const snapshot = doc.snapshot();
    const rawBoard = snapshot.prefabs?.find((p) => p.id === board);
    const rawSlot = snapshot.prefabEntities?.find((e) => e.id === slot);
    if (!rawBoard || !rawSlot) throw new Error("fixture");
    rawBoard.deletedParents = { gone: group };
    rawSlot.prefabOverrides = {
      ...rawSlot.prefabOverrides,
      [leaf]: { ...rawSlot.prefabOverrides?.[leaf], parent: "gone" },
    };
    doc.load(snapshot);
    const plan = doc.makePrefabFromEntity(group);
    const newSlot = plan.moved.find((m) => m.from === slot)?.to ?? "";
    expect(
      expandPrefabs(doc.snapshot()).entities.find(
        (e) => e.id === `${first}/${group}/${newSlot}/${leaf}`,
      )?.parent,
    ).toBe(`${first}/${group}`);
    expect(
      expandPrefabForEdit(doc.snapshot(), board)?.entities.find(
        (e) => e.id === `${group}/${newSlot}/${leaf}`,
      )?.parent,
    ).toBe(group);
    expect(
      expandPrefabForEdit(doc.snapshot(), plan.prefab.id)?.entities.find(
        (e) => e.id === `${newSlot}/${leaf}`,
      )?.parent,
    ).toBe(plan.prefab.root);
  });
});
