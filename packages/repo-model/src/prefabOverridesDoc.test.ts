import { FIELD_TYPE } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BUILTIN } from "./builtins";
import { expandPrefabForEdit, expandPrefabs, getPrefabOverride } from "./prefab";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";

function setup() {
  const doc = new ProjectDoc();
  doc.load(emptyProject("上書き"));
  const koko = doc.addKokoState("Health");
  doc.updateKokoState({
    id: koko,
    name: "Health",
    fields: [
      { id: "hp", name: "hp", type: FIELD_TYPE.number, default: 3 },
      { id: "max", name: "max", type: FIELD_TYPE.number, default: 10 },
    ],
  });
  const prefab = doc.addPrefab("的");
  const root = doc.prefab(prefab)?.root;
  if (!root) throw new Error("root");
  doc.addState(root, koko);
  const a = doc.addPrefabEntity({ prefab, name: "A", states: { [koko]: {} } });
  const b = doc.addPrefabEntity({ prefab, name: "B" });
  const instance = doc.addInstance({ output: "out_main", prefab, id: "instance" });
  const other = doc.addInstance({ output: "out_main", prefab, id: "other" });
  const at = (id: string) => expandPrefabs(doc.snapshot()).entities.find((e) => e.id === id);
  return { doc, koko, prefab, root, a, b, instance, other, child: `${instance}/${a}`, at };
}

it("親なしの並べ替えでも、別のアウトプットの Entity を混ぜない", () => {
  const doc = new ProjectDoc();
  doc.load(emptyProject("並び"));
  const output = doc.addOutput("別", "item");
  doc.addEntity({ id: "a", output: "out_main", name: "A" });
  doc.addEntity({ id: "b", output: "out_main", name: "B" });
  doc.addEntity({ id: "x", output, name: "X" });
  doc.placeEntity("a", null, 1);
  expect(doc.entities("out_main").map((e) => e.id)).toEqual(["b", "a"]);
  expect(doc.entity("x")?.order).toBe(0);
});

it("親の Group を複製しても、子のインスタンス内の追加 Entity を写す", () => {
  const { doc, instance, child } = setup();
  const group = doc.addEntity({ output: "out_main", name: "Group" });
  doc.setParent(instance, group);
  doc.addEntity({ output: "out_main", name: "追加", parent: child });
  const copied = doc.duplicateEntity(group, true);
  const copiedInstance = doc.entities().find((e) => e.parent === copied && e.instanceOf);
  expect(copiedInstance).toBeDefined();
  const copiedChild = child.replace(instance, copiedInstance?.id ?? "");
  expect(
    doc
      .entities()
      .filter((e) => e.parent === copiedChild)
      .map((e) => e.name),
  ).toEqual(["追加"]);
});

it("root に足した状態が後からプレハブに加わっても、フィールドを編集して戻せる", () => {
  const { doc, root, instance, koko, at } = setup();
  doc.removeState(root, koko);
  doc.addState(instance, koko, { hp: 5, max: 8 });
  doc.addState(root, koko, { hp: 3, max: 10 });
  const def = doc.kokostate(koko);
  if (!def) throw new Error("koko");
  doc.updateKokoState({
    ...def,
    fields: [...def.fields, { id: "new", name: "new", type: FIELD_TYPE.number, default: 20 }],
  });
  doc.setField(root, koko, "new", 30);
  expect(at(instance)?.states[koko]).toEqual({ hp: 5, max: 8, new: 30 });
  expect(getPrefabOverride(doc.snapshot(), instance)?.states?.[koko]?.hp).toBe(5);
  doc.setField(instance, koko, "hp", 7);
  expect(at(instance)?.states[koko]?.hp).toBe(7);
  doc.revertPrefabField(instance, koko, "hp");
  expect(at(instance)?.states[koko]).toEqual({ hp: 3, max: 8, new: 30 });
  doc.setField(root, koko, "hp", 4);
  expect(at(instance)?.states[koko]?.hp).toBe(4);
  doc.revertPrefabEntity(instance, "state", koko);
  expect(at(instance)?.states[koko]).toEqual({ hp: 4, max: 10, new: 30 });
  expect(doc.entity(instance)?.states[koko]).toBeUndefined();
});

it("中に足した状態が後からプレハブに加わっても、個別に元へ戻せる", () => {
  const { doc, child, a, koko, at } = setup();
  doc.removeState(a, koko);
  doc.addState(child, koko, { hp: 5, max: 8 });
  doc.addState(a, koko, { hp: 3, max: 10 });
  expect(getPrefabOverride(doc.snapshot(), child)?.states?.[koko]?.hp).toBe(5);
  expect(getPrefabOverride(doc.snapshot(), child)?.addedStates?.[koko]).toBeUndefined();
  doc.setField(child, koko, "hp", 7);
  expect(at(child)?.states[koko]?.hp).toBe(7);
  doc.revertPrefabField(child, koko, "hp");
  expect(at(child)?.states[koko]?.hp).toBe(3);
  doc.revertPrefabEntity(child, "state", koko);
  expect(at(child)?.states[koko]).toEqual({ hp: 3, max: 10 });
});

it("プレハブを開いていても、入れ子の中を親に追加・付け替えできる", () => {
  const { doc, prefab, a } = setup();
  const board = doc.addPrefab("盤");
  const nested = doc.addPrefabEntity({ prefab: board, name: "的", instanceOf: { prefab } });
  const parent = `${nested}/${a}`;
  const added = doc.addPrefabEntity({ prefab: board, name: "飾り", parent });
  const moved = doc.addPrefabEntity({ prefab: board, name: "移す" });
  doc.setParent(moved, parent);
  const other = doc.addPrefabEntity({
    prefab: board,
    name: "もう一つ",
    parent,
    instanceOf: { prefab },
  });
  const edited = expandPrefabForEdit(doc.snapshot(), board);
  for (const id of [added, moved, other])
    expect(edited?.entities.find((e) => e.id === id)?.parent).toBe(parent);
  const instance = doc.addInstance({ output: "out_main", prefab: board });
  const expanded = expandPrefabs(doc.snapshot());
  for (const id of [added, moved, other])
    expect(expanded.entities.find((e) => e.id === `${instance}/${id}`)?.parent).toBe(
      `${instance}/${parent}`,
    );
});

describe("インスタンスで変える操作", () => {
  it("根と子のフィールドを上書きし、ほかのフィールドとインスタンスはプレハブに追従する", () => {
    const { doc, koko, root, a, instance, other, child, at } = setup();
    doc.setField(instance, koko, "hp", 7);
    doc.setField(child, koko, "hp", 8);
    doc.setField(root, koko, "max", 20);
    doc.setField(a, koko, "max", 30);
    expect(at(instance)?.states[koko]).toEqual({ hp: 7, max: 20 });
    expect(at(child)?.states[koko]).toEqual({ hp: 8, max: 30 });
    expect(at(other)?.states[koko]).toEqual({ hp: 3, max: 20 });
    expect(doc.entity(instance)?.states[koko]).toBeUndefined();
    doc.revertPrefabField(child, koko, "hp");
    expect(at(child)?.states[koko]).toEqual({ hp: 3, max: 30 });
    doc.revertPrefabField(instance, koko, "hp");
    expect(doc.entity(instance)?.prefabOverrides).toBeUndefined();
  });

  it("初めて別々のフィールドを同時に変えても、両方の上書きが残る", () => {
    const { doc, child, koko, instance } = setup();
    const other = new ProjectDoc();
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(doc.doc));
    const before = Y.encodeStateVector(doc.doc);
    doc.setField(child, koko, "hp", 5);
    other.setField(child, koko, "max", 15);
    const a = Y.encodeStateAsUpdate(doc.doc, before);
    const b = Y.encodeStateAsUpdate(other.doc, before);
    Y.applyUpdate(doc.doc, b);
    Y.applyUpdate(other.doc, a);
    expect(doc.entity(instance)?.prefabOverrides).toEqual(other.entity(instance)?.prefabOverrides);
    expect(
      expandPrefabs(doc.snapshot()).entities.find((e) => e.id === child)?.states[koko],
    ).toEqual({ hp: 5, max: 15 });
  });

  it("子と根に KokoState を足せるが、プレハブから来た KokoState と Entity は消せない", () => {
    const { doc, koko, instance, child, at } = setup();
    doc.addState(child, BUILTIN.Mesh);
    doc.addState(instance, BUILTIN.Collider);
    expect(at(child)?.states[BUILTIN.Mesh]).toBeDefined();
    expect(at(instance)?.states[BUILTIN.Collider]).toBeDefined();
    expect(() => doc.removeState(child, koko)).toThrow("プレハブから来た");
    expect(() => doc.removeState(instance, koko)).toThrow("プレハブから来た");
    expect(() => doc.removeEntity(child)).toThrow("プレハブから来た");
    doc.removeState(child, BUILTIN.Mesh);
    doc.revertPrefabEntity(instance, "state", BUILTIN.Collider);
    expect(at(child)?.states[BUILTIN.Mesh]).toBeUndefined();
    expect(at(instance)?.states[BUILTIN.Collider]).toBeUndefined();
  });

  it("追加した Entity は、中の Entity を親にでき、消せる", () => {
    const { doc, child } = setup();
    const added = doc.addEntity({ output: "out_main", name: "追加", parent: child });
    expect(doc.entity(added)?.parent).toBe(child);
    doc.removeEntity(added);
    expect(doc.entity(added)).toBeUndefined();
  });

  it("並びと親を変え、輪になる付け替えを断り、一つずつ戻せる", () => {
    const { doc, instance, child, b, at } = setup();
    const otherChild = `${instance}/${b}`;
    doc.placeEntity(otherChild, instance, 0);
    expect(at(otherChild)?.order).toBe(0);
    expect(at(child)?.order).toBe(1);
    doc.setParent(child, otherChild);
    expect(at(child)?.parent).toBe(otherChild);
    expect(() => doc.setParent(otherChild, child)).toThrow("自分の子孫");
    doc.revertPrefabEntity(child, "parent");
    expect(at(child)?.parent).toBe(instance);
    doc.revertPrefabEntity(child, "order");
    doc.revertPrefabEntity(otherChild, "order");
    expect(doc.entity(instance)?.prefabOverrides).toBeUndefined();
  });

  it("もともといちばん上の下にある Entity を「親なし」にしても、変えた所に数えない", () => {
    const { doc, prefab, instance, other, child, b, at } = setup();
    doc.setParent(child, null);
    doc.placeEntity(child, null, 0);
    expect(at(child)?.parent).toBe(instance);
    expect(doc.entity(instance)?.prefabOverrides).toBeUndefined();
    // アウトプットのいちばん上へ落としても、並べ替えるのはインスタンスの中だけ（外の並びは変えない）
    doc.placeEntity(child, null, 5);
    expect([at(`${instance}/${b}`)?.order, at(child)?.order]).toEqual([0, 1]);
    expect([doc.entity(instance)?.order, doc.entity(other)?.order]).toEqual([0, 1]);
    doc.revertPrefabEntity(child, "order");
    doc.revertPrefabEntity(`${instance}/${b}`, "order");
    expect(doc.entity(instance)?.prefabOverrides).toBeUndefined();
    // 深い所にあるものを「親なし」にすると、インスタンスのいちばん上に付き、変えた所として残る
    const grand = doc.addPrefabEntity({ prefab, parent: b, name: "孫" });
    doc.setParent(`${instance}/${grand}`, null);
    expect(at(`${instance}/${grand}`)?.parent).toBe(instance);
    expect(doc.entity(instance)?.prefabOverrides).toEqual({ [grand]: { parent: null } });
  });

  it("消えた親を覚え、上書きした子と追加 Entity は残す", () => {
    const { doc, prefab, a, b, instance, child, at } = setup();
    const grand = doc.addPrefabEntity({ prefab, parent: b, name: "孫" });
    doc.setParent(child, `${instance}/${grand}`);
    const added = doc.addEntity({
      output: "out_main",
      name: "追加",
      parent: `${instance}/${grand}`,
    });
    doc.removeEntity(b);
    expect(doc.prefab(prefab)?.deletedParents).toMatchObject({ [grand]: b });
    expect(at(child)?.parent).toBe(instance);
    expect(at(added)?.parent).toBe(instance);
    expect(doc.prefabEntity(a)).toBeDefined();
  });

  it("根の複製は上書きを持つ別のインスタンスで、中の複製は追加 Entity になる", () => {
    const { doc, koko, instance, child, at } = setup();
    doc.setField(child, koko, "hp", 9);
    const added = doc.addEntity({ output: "out_main", name: "追加", parent: child });
    const rootCopy = doc.duplicateEntity(instance, true);
    expect(rootCopy).toBeDefined();
    const innerPath = child.slice(instance.length);
    expect(at(`${rootCopy}${innerPath}`)?.states[koko]?.hp).toBe(9);
    expect(doc.entity(rootCopy ?? "")?.instanceOf).toEqual(doc.entity(instance)?.instanceOf);
    const additions = doc.entities().filter((e) => e.parent === `${rootCopy}${innerPath}`);
    expect(additions.map((e) => e.name)).toEqual(["追加"]);
    expect(additions[0]?.id).not.toBe(added);
    const innerCopy = doc.duplicateEntity(child, true);
    expect(doc.entity(innerCopy ?? "")?.instanceOf).toBeUndefined();
    expect(doc.entity(innerCopy ?? "")?.states[koko]?.hp).toBe(9);
    expect(doc.entities().filter((e) => e.parent === innerCopy)).toHaveLength(1);
  });

  it("根を複製すると、上書きと追加 state の中の参照も複製先に付け替わる", () => {
    const { doc, child, instance, koko } = setup();
    const def = doc.kokostate(koko);
    if (!def) throw new Error("koko");
    doc.updateKokoState({
      ...def,
      fields: [
        ...def.fields,
        { id: "ref", name: "ref", type: FIELD_TYPE.entity, default: undefined },
        {
          id: "nested",
          name: "nested",
          type: "{ targets: EntityRef[] }",
          default: { targets: [] },
        },
      ],
    });
    doc.setField(child, koko, "ref", instance);
    doc.setField(child, koko, "nested", { targets: [child, "outside"] });
    const added = doc.addKokoState("Added");
    doc.updateKokoState({
      id: added,
      name: "Added",
      fields: [{ id: "ref", name: "ref", type: FIELD_TYPE.entity, default: undefined }],
    });
    doc.addState(instance, added, { ref: child });
    const copied = doc.duplicateEntity(instance, true, {
      [koko]: {
        nested: {
          kind: "record",
          fields: [
            {
              name: "targets",
              optional: false,
              schema: { kind: "list", item: { kind: "ref", target: "entity" } },
            },
          ],
        },
      },
    });
    const copiedChild = `${copied}${child.slice(instance.length)}`;
    const override = doc.entity(copied ?? "")?.prefabOverrides?.[child.slice(instance.length + 1)];
    expect(override?.states?.[koko]?.ref).toBe(copied);
    expect(override?.states?.[koko]?.nested).toEqual({ targets: [copiedChild, "outside"] });
    expect(doc.entity(copied ?? "")?.states[added]?.ref).toBe(copiedChild);
  });

  it("削除したリソースを、上書きと追加 System からも外す", () => {
    const { doc, child, instance, koko } = setup();
    const system = doc.addSystem("Extra", "");
    const material = doc.addMaterial("赤");
    doc.addState(child, BUILTIN.Mesh, { material });
    doc.setField(child, koko, "hp", 9);
    doc.setInstanceSystems(instance, [{ id: system, enabled: true }]);
    doc.removeMaterial(material);
    expect(
      expandPrefabs(doc.snapshot()).entities.find((e) => e.id === child)?.states[BUILTIN.Mesh]
        ?.material,
    ).toBeUndefined();
    doc.removeKokoState(koko);
    const overrides = doc.entity(instance)?.prefabOverrides;
    expect(
      Object.values(overrides ?? {}).some((v) => v.states?.[koko] || v.addedStates?.[koko]),
    ).toBe(false);
    doc.removeSystem(system);
    expect(doc.entity(instance)?.instanceSystems).toBeUndefined();
  });

  it("複製する追加 Entity を指す親の上書きと参照も、新しい側へ付け替える", () => {
    const { doc, child, instance, koko, a, at } = setup();
    const def = doc.kokostate(koko);
    if (!def) throw new Error("koko");
    doc.updateKokoState({
      ...def,
      fields: [
        ...def.fields,
        { id: "ref", name: "ref", type: FIELD_TYPE.entity, default: undefined },
        { id: "external", name: "external", type: FIELD_TYPE.entity, default: undefined },
      ],
    });
    const outside = doc.addEntity({ output: "out_main", name: "外" });
    const added = doc.addEntity({
      output: "out_main",
      name: "追加した親",
      parent: instance,
      states: { [koko]: { ref: child, external: outside } },
    });
    doc.setParent(child, added);
    doc.setField(child, koko, "ref", added);
    const copied = doc.duplicateEntity(instance, true);
    const copiedAdded = doc.entities().find((e) => e.parent === copied && e.name === "追加した親");
    expect(copiedAdded).toBeDefined();
    expect(at(`${copied}/${a}`)?.parent).toBe(copiedAdded?.id);
    expect(at(`${copied}/${a}`)?.states[koko]?.ref).toBe(copiedAdded?.id);
    expect(copiedAdded?.states[koko]).toMatchObject({ ref: `${copied}/${a}`, external: outside });
    expect(doc.entity(copied ?? "")?.prefabOverrides?.[a]?.parent).toBe(copiedAdded?.id);
  });

  it("継承 Entity の枝をふつうの Entity に複製しても、枝の中の参照はコピーを指す", () => {
    const { doc, child, prefab, a, instance, koko } = setup();
    const def = doc.kokostate(koko);
    if (!def) throw new Error("koko");
    doc.updateKokoState({
      ...def,
      fields: [
        ...def.fields,
        { id: "ref", name: "ref", type: FIELD_TYPE.entity, default: undefined },
        { id: "external", name: "external", type: FIELD_TYPE.entity, default: undefined },
      ],
    });
    const grand = doc.addPrefabEntity({
      prefab,
      parent: a,
      name: "継承した孫",
      states: { [koko]: { ref: a } },
    });
    doc.setField(child, koko, "ref", `${instance}/${grand}`);
    const added = doc.addEntity({
      output: "out_main",
      name: "追加した孫",
      parent: child,
      states: { [koko]: { ref: child, external: instance } },
    });
    const copied = doc.duplicateEntity(child, true);
    const children = doc.entities().filter((e) => e.parent === copied);
    const copiedGrand = children.find((e) => e.name === "継承した孫");
    const copiedAdded = children.find((e) => e.name === "追加した孫");
    expect(copiedGrand?.id).not.toBe(`${instance}/${grand}`);
    expect(copiedAdded?.id).not.toBe(added);
    expect(doc.entity(copied ?? "")?.states[koko]?.ref).toBe(copiedGrand?.id);
    expect(copiedGrand?.states[koko]?.ref).toBe(copied);
    expect(copiedAdded?.states[koko]).toMatchObject({ ref: copied, external: instance });
    expect([doc.entity(copied ?? ""), ...children].every((e) => e?.instanceOf === undefined)).toBe(
      true,
    );
  });

  it("追加した親を消しても、その下へ移したプレハブ由来の枝と維持の印は残す", () => {
    const { doc, child, instance, koko, at } = setup();
    const parent = doc.addEntity({ output: "out_main", name: "追加した親", parent: instance });
    const inner = doc.addEntity({ output: "out_main", name: "追加した子", parent });
    doc.setParent(child, inner);
    const keptChild = doc.addEntity({ output: "out_main", name: "残す子", parent: child });
    const out = doc.output("out_main");
    if (!out) throw new Error("output");
    const keep = { entity: child, koko, field: "hp" };
    doc.updateOutput({ ...out, keep: [keep, { entity: inner, koko, field: "hp" }] });
    doc.removeEntity(parent);
    expect(doc.entity(parent)).toBeUndefined();
    expect(doc.entity(inner)).toBeUndefined();
    expect(at(child)?.parent).toBe(instance);
    expect(doc.entity(keptChild)?.parent).toBe(child);
    expect(doc.output("out_main")?.keep).toEqual([keep]);
  });

  it("インスタンスを消すと追加 Entity と中を指す維持の印を外す", () => {
    const { doc, child, instance, koko } = setup();
    const added = doc.addEntity({ output: "out_main", name: "追加", parent: child });
    const out = doc.output("out_main");
    if (!out) throw new Error("output");
    doc.updateOutput({
      ...out,
      keep: [
        { entity: child, koko, field: "hp" },
        { entity: added, koko, field: "hp" },
      ],
    });
    doc.removeEntity(instance);
    expect(doc.entity(added)).toBeUndefined();
    expect(doc.output("out_main")?.keep).toEqual([]);
  });

  it("上書き・追加 KokoState・System を読み込み直しても保つ", () => {
    const { doc, child, instance, koko } = setup();
    doc.setField(child, koko, "hp", 9);
    doc.addState(child, BUILTIN.Mesh);
    doc.setInstanceSystems(instance, [{ id: "extra", enabled: false }]);
    const restored = new ProjectDoc();
    restored.load(doc.snapshot());
    expect(restored.snapshot()).toEqual(doc.snapshot());
    expect(expandPrefabs(restored.snapshot())).toEqual(expandPrefabs(doc.snapshot()));
    doc.setInstanceSystems(instance, []);
    expect(doc.entity(instance)?.instanceSystems).toBeUndefined();
  });
});
