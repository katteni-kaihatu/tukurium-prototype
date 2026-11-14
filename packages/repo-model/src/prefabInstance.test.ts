import { FIELD_TYPE, type FieldSchemas } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BUILTIN } from "./builtins";
import { fromFiles, toFiles } from "./files";
import { expandPrefabs, prefabProblems } from "./prefab";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";

const OUT = "out_main";

function setup() {
  const doc = new ProjectDoc();
  doc.load(emptyProject("適用と解除"));
  const koko = doc.addKokoState("Link");
  doc.updateKokoState({
    id: koko,
    name: "Link",
    fields: [
      { id: "hp", name: "hp", type: FIELD_TYPE.number, default: 3 },
      { id: "max", name: "max", type: FIELD_TYPE.number, default: 10 },
      { id: "to", name: "to", type: FIELD_TYPE.entity, default: undefined },
      { id: "many", name: "many", type: "EntityRef[]", default: [] },
    ],
  });
  const schemas: FieldSchemas = {
    [koko]: { many: { kind: "list", item: { kind: "ref", target: "entity" } } },
  };
  const prefab = doc.addPrefab("的");
  const root = doc.prefab(prefab)?.root;
  if (!root) throw new Error("root");
  doc.addState(root, koko);
  const a = doc.addPrefabEntity({ prefab, name: "A", states: { [koko]: {} } });
  const b = doc.addPrefabEntity({ prefab, name: "B", states: { [koko]: {} } });
  const instance = doc.addInstance({ output: OUT, prefab, id: "instance" });
  const other = doc.addInstance({ output: OUT, prefab, id: "other" });
  const at = (id: string) => {
    const entity = expandPrefabs(doc.snapshot(), { schemas }).entities.find((e) => e.id === id);
    if (!entity) throw new Error(`missing ${id}`);
    return entity;
  };
  return { doc, koko, schemas, prefab, root, a, b, instance, other, child: `${instance}/${a}`, at };
}

describe("インスタンスの変更をプレハブに適用", () => {
  it("入れ子のルートが自前の値と上書きを両方持っていても、外側で変えた値を適用・解除できる", () => {
    const { doc, koko, schemas, prefab: inner } = setup();
    const outer = doc.addPrefab("盤");
    const nested = doc.addPrefabEntity({
      prefab: outer,
      name: "的",
      instanceOf: { prefab: inner },
      states: { [koko]: { hp: 6 } },
    });
    doc.setField(nested, koko, "hp", 8);
    const source = doc.addInstance({ output: OUT, prefab: outer });
    doc.setField(`${source}/${nested}`, koko, "hp", 9);
    doc.applyPrefabInstance(source, { schemas });
    const at = () =>
      expandPrefabs(doc.snapshot(), { schemas }).entities.find(
        (e) => e.id === `${source}/${nested}`,
      );
    expect(at()?.states[koko]?.hp).toBe(9);
    doc.setField(`${source}/${nested}`, koko, "hp", 10);
    const plan = doc.unpackPrefabInstance(source, { schemas });
    expect(
      expandPrefabs(doc.snapshot(), { schemas }).entities.find((e) => e.id === plan.ids[nested])
        ?.states[koko]?.hp,
    ).toBe(10);
  });

  it("計画では書き込まず、作り直しても指定した新しい ID を保つ", () => {
    const { doc, instance, child, koko, schemas } = setup();
    const added = doc.addEntity({ output: OUT, name: "追加", parent: child });
    const before = doc.snapshot();
    const first = doc.planApplyPrefabInstance(instance, { schemas });
    expect(first.ok).toBe(true);
    expect(doc.snapshot()).toEqual(before);
    if (!first.ok) return;
    const nextId = first.plan.ids[added];
    expect(nextId).toBeDefined();
    doc.setField(child, koko, "hp", 8);
    const next = doc.planApplyPrefabInstance(instance, { schemas, ids: first.plan.ids });
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.plan.ids[added]).toBe(nextId);
  });

  it("変えた値と子の名前・親・並びを適用し、他のインスタンスの上書きは残す", () => {
    const { doc, instance, other, prefab, root, a, b, child, koko, schemas, at } = setup();
    const rootBefore = doc.prefabEntity(root);
    doc.renameEntity(instance, "置いた的");
    doc.setField(instance, BUILTIN.Transform, "position", [7, 2, 1]);
    doc.setField(instance, BUILTIN.Transform, "rotation", [0, 45, 0]);
    doc.setField(instance, BUILTIN.Transform, "scale", [2, 3, 4]);
    doc.setField(instance, koko, "hp", 11);
    doc.setField(child, koko, "hp", 8);
    doc.renameEntity(child, "変更した A");
    doc.placeEntity(child, `${instance}/${b}`, 0);
    doc.setField(`${other}/${a}`, koko, "hp", 99);
    const placed = doc.entity(instance);
    let changes = 0;
    const stop = doc.observe(() => changes++);
    doc.applyPrefabInstance(instance, { schemas });
    stop();
    expect(changes).toBe(1);
    expect(doc.entity(instance)).toMatchObject({
      name: placed?.name,
      parent: placed?.parent,
      order: placed?.order,
      states: placed?.states && { [BUILTIN.Transform]: placed.states[BUILTIN.Transform] },
    });
    expect(doc.prefabEntity(root)?.states[BUILTIN.Transform]).toEqual(
      rootBefore?.states[BUILTIN.Transform],
    );
    expect(doc.prefabEntity(root)?.states[koko]?.hp).toBe(11);
    expect(doc.prefabEntity(a)).toMatchObject({ name: "変更した A", parent: b, order: 0 });
    expect(doc.entity(instance)?.prefabOverrides).toBeUndefined();
    expect(at(child).states[koko]).toMatchObject({ hp: 8, max: 10 });
    expect(at(other).states[koko]?.hp).toBe(11);
    expect(at(`${other}/${a}`).states[koko]?.hp).toBe(99);
    expect(doc.prefab(prefab)?.root).toBe(root);
  });

  it("追加した KokoState と System を移し、元の追加分を消す", () => {
    const { doc, instance, other, root, a, child, schemas, at, prefab } = setup();
    const system = doc.addSystem("追加System", "");
    doc.addState(instance, BUILTIN.Collider, { shape: "box" });
    doc.addState(child, BUILTIN.Mesh, { shape: "sphere" });
    doc.setInstanceSystems(instance, [{ id: system, enabled: true }]);
    doc.applyPrefabInstance(instance, { schemas });
    expect(doc.prefabEntity(root)?.states[BUILTIN.Collider]).toBeDefined();
    expect(doc.prefabEntity(a)?.states[BUILTIN.Mesh]?.shape).toBe("sphere");
    expect(doc.entity(instance)?.states[BUILTIN.Collider]).toEqual({});
    expect(doc.planApplyPrefabInstance(instance, { schemas })).toMatchObject({
      ok: true,
      plan: { changes: [] },
    });
    expect(doc.entity(instance)?.instanceSystems).toBeUndefined();
    expect(doc.prefab(prefab)?.systems).toEqual([{ id: system, enabled: true }]);
    expect(at(other).states[BUILTIN.Collider]).toBeDefined();
    expect(at(`${other}/${a}`).states[BUILTIN.Mesh]?.shape).toBe("sphere");
  });

  it("確認に出す変更は、KokoState・System・親を ID ではなく名前で示す", () => {
    const { doc, instance, child, b, schemas } = setup();
    const system = doc.addSystem("追加System", "");
    const extra = doc.addKokoState("Extra");
    doc.addState(instance, extra);
    doc.setInstanceSystems(instance, [{ id: system, enabled: true }]);
    doc.setParent(child, `${instance}/${b}`);
    const result = doc.planApplyPrefabInstance(instance, { schemas });
    if (!result.ok) throw new Error(result.reason);
    const details = result.plan.changes.map((c) => c.detail);
    expect(details).toEqual(
      expect.arrayContaining([
        "親: 「B」",
        "追加した KokoState: Extra",
        "追加した System: 追加System",
      ]),
    );
    for (const id of [system, extra, b]) expect(details.join("\n")).not.toContain(id);
  });

  it("追加 Entity の親・参照・上書き内の参照・維持の印を新しい ID に付け替える", () => {
    const { doc, instance, other, root, a, child, koko, schemas, at, prefab } = setup();
    const added = doc.addEntity({
      output: OUT,
      name: "追加親",
      parent: instance,
      states: { [koko]: { to: child } },
    });
    const leaf = doc.addEntity({
      output: OUT,
      name: "追加子",
      parent: added,
      states: { [koko]: { many: [instance, added, child] } },
    });
    doc.setParent(child, added);
    doc.setField(child, koko, "to", leaf);
    doc.setField(`${other}/${a}`, koko, "many", [added, leaf]);
    const outside = doc.addEntity({
      output: OUT,
      name: "外",
      states: { [koko]: { to: added, many: [leaf, child] } },
    });
    const foreign = doc.addPrefab("別の部品");
    const foreignChild = doc.addPrefabEntity({
      prefab: foreign,
      name: "参照元",
      states: { [koko]: { to: leaf } },
    });
    const output = doc.output(OUT);
    if (!output) throw new Error("output");
    doc.updateOutput({
      ...output,
      keep: [
        { entity: instance, koko: BUILTIN.Transform, field: "position" },
        { entity: child, koko, field: "hp" },
        { entity: leaf, koko, field: "hp" },
      ],
    });
    const plan = doc.applyPrefabInstance(instance, { schemas });
    const parentId = plan.ids[added] as string;
    const leafId = plan.ids[leaf] as string;
    expect(doc.entity(added)).toBeUndefined();
    expect(doc.entity(leaf)).toBeUndefined();
    expect(doc.prefabEntity(parentId)).toMatchObject({
      parent: root,
      states: { [koko]: { to: a } },
    });
    expect(doc.prefabEntity(leafId)).toMatchObject({
      parent: parentId,
      states: { [koko]: { many: [root, parentId, a] } },
    });
    expect(doc.prefabEntity(a)).toMatchObject({
      parent: parentId,
      states: { [koko]: { to: leafId } },
    });
    expect(at(`${other}/${a}`).parent).toBe(`${other}/${parentId}`);
    expect(at(`${other}/${a}`).states[koko]?.many).toEqual([
      `${instance}/${parentId}`,
      `${instance}/${leafId}`,
    ]);
    expect(doc.entity(outside)?.states[koko]).toMatchObject({
      to: `${instance}/${parentId}`,
      many: [`${instance}/${leafId}`, child],
    });
    expect(doc.prefabEntity(foreignChild)?.states[koko]?.to).toBe(`${instance}/${leafId}`);
    expect(doc.output(OUT)?.keep).toEqual([
      { entity: instance, koko: BUILTIN.Transform, field: "position" },
    ]);
    expect(doc.prefab(prefab)?.keep).toEqual(
      expect.arrayContaining([
        { entity: a, koko, field: "hp" },
        { entity: leafId, koko, field: "hp" },
      ]),
    );
  });

  it("追加したインスタンスを移しても、入れ子の上書きと内外の参照を保つ", () => {
    const { doc, instance, child, a, koko, schemas, prefab } = setup();
    const inner = doc.addPrefab("駒");
    const leaf = doc.addPrefabEntity({ prefab: inner, name: "芯", states: { [koko]: {} } });
    const nested = doc.addEntity({
      output: OUT,
      name: "足した駒",
      parent: instance,
      instanceOf: { prefab: inner },
    });
    doc.setField(`${nested}/${leaf}`, koko, "hp", 19);
    doc.setField(`${nested}/${leaf}`, koko, "to", child);
    const outside = doc.addEntity({
      output: OUT,
      name: "外",
      states: { [koko]: { to: `${nested}/${leaf}` } },
    });
    const plan = doc.applyPrefabInstance(instance, { schemas });
    const nestedId = plan.ids[nested] as string;
    expect(doc.entity(nested)).toBeUndefined();
    expect(doc.prefabEntity(nestedId)).toMatchObject({
      prefab,
      instanceOf: { prefab: inner },
      prefabOverrides: { [leaf]: { states: { [koko]: { hp: 19, to: a } } } },
    });
    expect(doc.entity(outside)?.states[koko]?.to).toBe(`${instance}/${nestedId}/${leaf}`);
    expect(
      expandPrefabs(doc.snapshot(), { schemas }).entities.find(
        (e) => e.id === `${instance}/${nestedId}/${leaf}`,
      )?.states[koko],
    ).toMatchObject({ hp: 19, to: child });
  });

  it("プレハブで消えた親への上書きは、展開時に選ばれた残る親へ適用する", () => {
    const { doc, instance, prefab, root, a, b, child, schemas } = setup();
    doc.setParent(child, `${instance}/${b}`);
    doc.removeEntity(b);
    doc.applyPrefabInstance(instance, { schemas });
    expect(doc.prefabEntity(a)?.parent).toBe(root);
    expect(doc.prefab(prefab)?.deletedParents?.[b]).toBe(root);
    expect(doc.entity(instance)?.prefabOverrides).toBeUndefined();
  });

  it("インスタンスの外へ付け替えた親は理由付きで断り、データを変えない", () => {
    const { doc, instance, child, schemas } = setup();
    const outside = doc.addEntity({ output: OUT, name: "外の親" });
    doc.setParent(child, outside);
    const before = doc.snapshot();
    const plan = doc.planApplyPrefabInstance(instance, { schemas });
    expect(plan).toMatchObject({ ok: false, reason: expect.stringContaining("インスタンスの外") });
    expect(() => doc.applyPrefabInstance(instance, { schemas })).toThrow("インスタンスの外");
    expect(doc.snapshot()).toEqual(before);
  });

  it("入れ子への外側の上書きは入れ子のインスタンスに移し、内側プレハブは変えない", () => {
    const { doc, koko, schemas, prefab: inner, a: leaf } = setup();
    const outer = doc.addPrefab("盤");
    const nested = doc.addPrefabEntity({
      prefab: outer,
      name: "的",
      instanceOf: { prefab: inner },
    });
    const source = doc.addInstance({ output: OUT, prefab: outer });
    const other = doc.addInstance({ output: OUT, prefab: outer });
    doc.setField(`${source}/${nested}/${leaf}`, koko, "hp", 12);
    doc.setField(`${source}/${nested}`, koko, "max", 40);
    doc.applyPrefabInstance(source, { schemas });
    expect(doc.prefabEntity(leaf)?.states[koko]?.hp).toBe(3);
    expect(doc.prefabEntity(nested)?.prefabOverrides).toMatchObject({
      [leaf]: { states: { [koko]: { hp: 12 } } },
      "": { states: { [koko]: { max: 40 } } },
    });
    expect(
      expandPrefabs(doc.snapshot(), { schemas }).entities.find(
        (e) => e.id === `${other}/${nested}/${leaf}`,
      )?.states[koko]?.hp,
    ).toBe(12);
    expect(doc.entity(source)?.prefabOverrides).toBeUndefined();
  });

  it("プレハブ内のインスタンスから適用すると、その参照先だけを更新する", () => {
    const { doc, koko, schemas, prefab: inner, a: leaf } = setup();
    const outer = doc.addPrefab("盤");
    const nested = doc.addPrefabEntity({
      prefab: outer,
      name: "的",
      instanceOf: { prefab: inner },
    });
    const decoration = doc.addPrefabEntity({
      prefab: outer,
      name: "足した飾り",
      parent: `${nested}/${leaf}`,
      states: { [koko]: { to: nested } },
    });
    doc.setField(`${nested}/${leaf}`, koko, "hp", 12);
    const plan = doc.applyPrefabInstance(nested, { schemas });
    const decorationId = plan.ids[decoration] as string;
    expect(doc.prefabEntity(leaf)?.states[koko]?.hp).toBe(12);
    expect(doc.prefabEntity(decoration)).toBeUndefined();
    expect(doc.prefabEntity(decorationId)).toMatchObject({ prefab: inner, parent: leaf });
    expect(doc.prefabEntity(nested)?.prefabOverrides).toBeUndefined();
  });

  it("適用と他の人の別フィールド変更を交換しても両方が残る", () => {
    const { doc, instance, child, a, koko, schemas } = setup();
    doc.setField(child, koko, "hp", 8);
    const remote = new ProjectDoc();
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(doc.doc));
    const before = Y.encodeStateVector(doc.doc);
    doc.applyPrefabInstance(instance, { schemas });
    remote.setField(a, koko, "max", 77);
    remote.setField(child, koko, "to", "outside");
    const localUpdate = Y.encodeStateAsUpdate(doc.doc, before);
    const remoteUpdate = Y.encodeStateAsUpdate(remote.doc, before);
    Y.applyUpdate(doc.doc, remoteUpdate);
    Y.applyUpdate(remote.doc, localUpdate);
    expect(doc.snapshot()).toEqual(remote.snapshot());
    expect(doc.prefabEntity(a)?.states[koko]).toMatchObject({ hp: 8, max: 77 });
    expect(doc.entity(instance)?.prefabOverrides?.[a]?.states?.[koko]?.to).toBe("outside");
    expect(doc.entity(instance)?.prefabOverrides?.[a]?.states?.[koko]?.hp).toBeUndefined();
  });
});

describe("インスタンスをふつうの Entity に戻す", () => {
  it("一段だけ解除して根の配置・子の値・既存の追加 Entity を保ち、参照を付け替える", () => {
    const { doc, instance, child, a, b, root, koko, schemas, at } = setup();
    doc.renameEntity(instance, "置いた的");
    doc.setField(instance, BUILTIN.Transform, "position", [3, 4, 5]);
    doc.setField(child, koko, "hp", 9);
    doc.setField(child, koko, "to", instance);
    doc.setField(child, koko, "many", [`${instance}/${b}`, child]);
    const addition = doc.addEntity({
      output: OUT,
      name: "足したもの",
      parent: child,
      states: { [koko]: { to: `${instance}/${b}` } },
    });
    const outside = doc.addEntity({
      output: OUT,
      name: "参照元",
      states: { [koko]: { to: child } },
    });
    const beforeRoot = at(instance);
    const plan = doc.unpackPrefabInstance(instance, { schemas });
    const childId = plan.ids[a] as string;
    const bId = plan.ids[b] as string;
    expect(doc.entity(instance)).toMatchObject({
      name: "置いた的",
      parent: beforeRoot.parent,
      order: beforeRoot.order,
      states: beforeRoot.states,
    });
    expect(doc.entity(instance)?.instanceOf).toBeUndefined();
    expect(doc.entity(instance)?.prefabOverrides).toBeUndefined();
    expect(doc.entity(childId)).toMatchObject({
      parent: instance,
      states: { [koko]: { hp: 9, to: instance, many: [bId, childId] } },
    });
    expect(doc.entity(addition)).toMatchObject({
      parent: childId,
      states: { [koko]: { to: bId } },
    });
    expect(doc.entity(outside)?.states[koko]?.to).toBe(childId);
    doc.setField(a, koko, "hp", 31);
    doc.setField(root, koko, "max", 44);
    expect(doc.entity(childId)?.states[koko]?.hp).toBe(9);
    expect(doc.entity(instance)?.states[koko]?.max).toBe(10);
  });

  it("入れ子のリンクと上書きを残し、外側だけ変更への追随を止める", () => {
    const { doc, koko, schemas, prefab: inner, a: leaf } = setup();
    const outer = doc.addPrefab("盤");
    const nested = doc.addPrefabEntity({
      prefab: outer,
      name: "的",
      instanceOf: { prefab: inner },
    });
    const source = doc.addInstance({ output: OUT, prefab: outer });
    doc.setField(`${source}/${nested}/${leaf}`, koko, "hp", 12);
    const plan = doc.unpackPrefabInstance(source, { schemas });
    const nestedId = plan.ids[nested] as string;
    expect(doc.entity(nestedId)?.instanceOf).toEqual({ prefab: inner });
    expect(doc.entity(nestedId)?.prefabOverrides?.[leaf]?.states?.[koko]?.hp).toBe(12);
    expect(doc.entities().some((e) => e.id === `${nestedId}/${leaf}`)).toBe(false);
    doc.setField(leaf, koko, "max", 62);
    const shown = expandPrefabs(doc.snapshot(), { schemas }).entities.find(
      (e) => e.id === `${nestedId}/${leaf}`,
    );
    expect(shown?.states[koko]).toMatchObject({ hp: 12, max: 62 });
    doc.renameEntity(nested, "元だけ変更");
    expect(doc.entity(nestedId)?.name).toBe("的");
  });

  it("維持の印は実体 ID へ移し、入れ子自身の印は重複させない", () => {
    const { doc, koko, schemas, prefab: inner, a: leaf } = setup();
    const innerDef = doc.prefab(inner);
    if (!innerDef) throw new Error("inner");
    doc.updatePrefab({ ...innerDef, keep: [{ entity: leaf, koko, field: "hp" }] });
    const outer = doc.addPrefab("盤");
    const outerRoot = doc.prefab(outer)?.root;
    if (!outerRoot) throw new Error("outer root");
    doc.addState(outerRoot, koko);
    const nested = doc.addPrefabEntity({
      prefab: outer,
      name: "的",
      instanceOf: { prefab: inner },
    });
    const outerDef = doc.prefab(outer);
    if (!outerDef) throw new Error("outer");
    doc.updatePrefab({ ...outerDef, keep: [{ entity: outerRoot, koko, field: "max" }] });
    const source = doc.addInstance({ output: OUT, prefab: outer });
    const output = doc.output(OUT);
    if (!output) throw new Error("output");
    doc.updateOutput({
      ...output,
      keep: [{ entity: `${source}/${nested}/${leaf}`, koko, field: "max" }],
    });
    const plan = doc.unpackPrefabInstance(source, { schemas });
    const nestedId = plan.ids[nested] as string;
    expect(doc.output(OUT)?.keep).toEqual(
      expect.arrayContaining([
        { entity: source, koko, field: "max" },
        { entity: `${nestedId}/${leaf}`, koko, field: "max" },
      ]),
    );
    const effective = expandPrefabs(doc.snapshot(), { schemas }).outputs.find(
      (o) => o.id === OUT,
    )?.keep;
    expect(
      effective?.filter((k) => k.entity === `${nestedId}/${leaf}` && k.field === "hp"),
    ).toHaveLength(1);
    expect(
      doc.output(OUT)?.keep.some((k) => k.entity === `${nestedId}/${leaf}` && k.field === "hp"),
    ).toBe(false);
  });

  it("プレハブの中に置いたインスタンスも、その持ち主の中で解除できる", () => {
    const { doc, koko, schemas, prefab: inner, a: leaf } = setup();
    const outer = doc.addPrefab("盤");
    const nested = doc.addPrefabEntity({
      prefab: outer,
      name: "的",
      instanceOf: { prefab: inner },
    });
    const source = doc.addInstance({ output: OUT, prefab: outer });
    doc.setField(`${nested}/${leaf}`, koko, "hp", 12);
    const plan = doc.unpackPrefabInstance(nested, { schemas });
    const leafId = plan.ids[leaf] as string;
    expect(doc.prefabEntity(nested)?.instanceOf).toBeUndefined();
    expect(doc.prefabEntity(leafId)).toMatchObject({
      prefab: outer,
      parent: nested,
      states: { [koko]: { hp: 12 } },
    });
    expect(
      expandPrefabs(doc.snapshot(), { schemas }).entities.find(
        (e) => e.id === `${source}/${leafId}`,
      )?.states[koko]?.hp,
    ).toBe(12);
  });

  it("解除後の値・System・上書きをファイルと Y.Doc から読み直しても保つ", () => {
    const { doc, instance, child, koko, schemas, prefab } = setup();
    const system = doc.addSystem("動く", "");
    const extra = doc.addSystem("追加", "");
    const def = doc.prefab(prefab);
    if (!def) throw new Error("prefab");
    doc.updatePrefab({ ...def, systems: [{ id: system, enabled: true }] });
    doc.setInstanceSystems(instance, [{ id: extra, enabled: false }]);
    doc.setField(child, koko, "hp", 9);
    doc.unpackPrefabInstance(instance, { schemas });
    const files = toFiles(doc.snapshot());
    const restored = new ProjectDoc();
    restored.load(fromFiles(files));
    expect(toFiles(restored.snapshot())).toEqual(files);
    const remote = new ProjectDoc();
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(doc.doc));
    expect(remote.snapshot()).toEqual(doc.snapshot());
    expect(restored.entity(instance)?.unpackedSystems).toEqual([{ id: system, enabled: true }]);
    expect(restored.entity(instance)?.instanceSystems).toEqual([{ id: extra, enabled: false }]);
  });
});

describe("適用・解除を断る場合", () => {
  it("ライブラリへの適用を断る", () => {
    const { doc, instance } = setup();
    const e = doc.entity(instance);
    if (!e) throw new Error("instance");
    doc.restoreEntity({ ...e, instanceOf: { prefab: "pkg:library@1/prefab" } });
    expect(doc.planApplyPrefabInstance(instance)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ライブラリ"),
    });
  });

  it("適用で自分を含むプレハブになるときは、何も書き換えずに断る", () => {
    const { doc, instance, prefab, schemas } = setup();
    doc.addEntity({ output: OUT, name: "自分と同じ", parent: instance, instanceOf: { prefab } });
    const before = doc.snapshot();
    expect(doc.planApplyPrefabInstance(instance, { schemas })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("自分を含む"),
    });
    expect(doc.snapshot()).toEqual(before);
  });

  it("プレハブで消えた Entity に上書きが残っていれば、適用前に知らせる", () => {
    const { doc, instance, child, a, koko, schemas } = setup();
    doc.setField(child, koko, "hp", 9);
    doc.removeEntity(a);
    const before = doc.snapshot();
    expect(doc.planApplyPrefabInstance(instance, { schemas })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("変更先の Entity"),
    });
    expect(doc.snapshot()).toEqual(before);
  });

  it("元を消してもインスタンスと問題を残し、欠けた中身を解除・適用しない", () => {
    const { doc, instance, prefab, child, koko } = setup();
    doc.setField(child, koko, "hp", 9);
    doc.removePrefab(prefab);
    const before = doc.snapshot();
    expect(doc.entity(instance)?.instanceOf?.prefab).toBe(prefab);
    expect(prefabProblems(before)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "missing", entity: instance, prefab }),
      ]),
    );
    expect(doc.planApplyPrefabInstance(instance)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("プレハブがありません"),
    });
    expect(doc.planUnpackPrefabInstance(instance)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("プレハブがありません"),
    });
    expect(doc.snapshot()).toEqual(before);
  });
});

describe("別のプレハブから使われている中身の ID を変える", () => {
  function chained() {
    const base = setup();
    const { doc, prefab: inner } = base;
    const middle = doc.addPrefab("中の部品");
    const nested = doc.addPrefabEntity({
      prefab: middle,
      name: "的",
      instanceOf: { prefab: inner },
    });
    const outer = doc.addPrefab("外の部品");
    const wrapper = doc.addPrefabEntity({
      prefab: outer,
      name: "中",
      instanceOf: { prefab: middle },
    });
    const instance = doc.addInstance({ output: OUT, prefab: outer, id: "outer_instance" });
    const second = doc.addInstance({ output: OUT, prefab: outer, id: "second_outer_instance" });
    return { ...base, inner, middle, nested, outer, wrapper, instance, second };
  }

  it("内側の解除では、上位二段の参照・上書きのキー・維持の印も付け替える", () => {
    const { doc, koko, schemas, a, middle, nested, outer, wrapper, instance, second } = chained();
    const oldLocal = `${nested}/${a}`;
    const oldOuter = `${wrapper}/${oldLocal}`;
    const oldOutput = `${instance}/${oldOuter}`;
    const observer = doc.addEntity({
      output: OUT,
      name: "外から参照",
      states: { [koko]: { to: oldOutput } },
    });
    const outerObserver = doc.addPrefabEntity({
      prefab: outer,
      name: "部品から参照",
      states: { [koko]: { many: [oldOuter] } },
    });
    doc.setField(`${wrapper}/${oldLocal}`, koko, "hp", 80);
    doc.setField(oldOutput, koko, "max", 90);
    doc.setField(`${second}/${oldOuter}`, koko, "to", oldOutput);
    const output = doc.output(OUT);
    const outerDef = doc.prefab(outer);
    if (!output || !outerDef) throw new Error("owner");
    doc.updateOutput({ ...output, keep: [{ entity: oldOutput, koko, field: "hp" }] });
    doc.updatePrefab({ ...outerDef, keep: [{ entity: oldOuter, koko, field: "max" }] });

    const plan = doc.unpackPrefabInstance(nested, { schemas });
    const leaf = plan.ids[a] as string;
    const outerPath = `${wrapper}/${leaf}`;
    const outputPath = `${instance}/${outerPath}`;
    expect(doc.prefabEntity(leaf)?.prefab).toBe(middle);
    expect(doc.entity(observer)?.states[koko]?.to).toBe(outputPath);
    expect(doc.prefabEntity(outerObserver)?.states[koko]?.many).toEqual([outerPath]);
    expect(doc.prefabEntity(wrapper)?.prefabOverrides?.[leaf]?.states?.[koko]?.hp).toBe(80);
    expect(doc.entity(instance)?.prefabOverrides?.[outerPath]?.states?.[koko]?.max).toBe(90);
    expect(doc.entity(second)?.prefabOverrides?.[outerPath]?.states?.[koko]?.to).toBe(outputPath);
    expect(doc.output(OUT)?.keep).toContainEqual({ entity: outputPath, koko, field: "hp" });
    expect(doc.prefab(outer)?.keep).toContainEqual({ entity: outerPath, koko, field: "max" });
    const shown = expandPrefabs(doc.snapshot(), { schemas }).entities.find(
      (e) => e.id === outputPath,
    );
    expect(shown?.states[koko]).toMatchObject({ hp: 80, max: 90 });
  });

  it("内側への追加 Entity の適用では、上位二段の参照・上書きのキー・維持の印も付け替える", () => {
    const { doc, koko, schemas, a, inner, middle, nested, outer, wrapper, instance, second } =
      chained();
    const added = doc.addPrefabEntity({
      prefab: middle,
      name: "追加",
      parent: `${nested}/${a}`,
      states: { [koko]: { to: nested } },
    });
    const oldOuter = `${wrapper}/${added}`;
    const oldOutput = `${instance}/${oldOuter}`;
    const observer = doc.addEntity({
      output: OUT,
      name: "外から参照",
      states: { [koko]: { to: oldOutput } },
    });
    const outerObserver = doc.addPrefabEntity({
      prefab: outer,
      name: "部品から参照",
      states: { [koko]: { many: [oldOuter] } },
    });
    doc.setField(`${wrapper}/${added}`, koko, "hp", 80);
    doc.setField(oldOutput, koko, "max", 90);
    doc.setField(`${second}/${oldOuter}`, koko, "to", oldOutput);
    const output = doc.output(OUT);
    const outerDef = doc.prefab(outer);
    if (!output || !outerDef) throw new Error("owner");
    doc.updateOutput({ ...output, keep: [{ entity: oldOutput, koko, field: "hp" }] });
    doc.updatePrefab({ ...outerDef, keep: [{ entity: oldOuter, koko, field: "max" }] });

    const plan = doc.applyPrefabInstance(nested, { schemas });
    const addedId = plan.ids[added] as string;
    const local = `${nested}/${addedId}`;
    const outerPath = `${wrapper}/${local}`;
    const outputPath = `${instance}/${outerPath}`;
    expect(doc.prefabEntity(addedId)?.prefab).toBe(inner);
    expect(doc.prefabEntity(added)).toBeUndefined();
    expect(doc.entity(observer)?.states[koko]?.to).toBe(outputPath);
    expect(doc.prefabEntity(outerObserver)?.states[koko]?.many).toEqual([outerPath]);
    expect(doc.prefabEntity(wrapper)?.prefabOverrides?.[local]?.states?.[koko]?.hp).toBe(80);
    expect(doc.entity(instance)?.prefabOverrides?.[outerPath]?.states?.[koko]?.max).toBe(90);
    expect(doc.entity(second)?.prefabOverrides?.[outerPath]?.states?.[koko]?.to).toBe(outputPath);
    expect(doc.output(OUT)?.keep).toContainEqual({ entity: outputPath, koko, field: "hp" });
    expect(doc.prefab(outer)?.keep).toContainEqual({ entity: outerPath, koko, field: "max" });
    const shown = expandPrefabs(doc.snapshot(), { schemas }).entities.find(
      (e) => e.id === outputPath,
    );
    expect(shown?.states[koko]).toMatchObject({ hp: 80, max: 90 });
  });
});
