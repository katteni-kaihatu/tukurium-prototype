import { FIELD_TYPE } from "@tukurium/eks";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { expandPrefabs } from "./prefab";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";

function setup() {
  const doc = new ProjectDoc();
  doc.load(emptyProject("test"));
  const koko = doc.addKokoState("Values");
  doc.updateKokoState({
    id: koko,
    name: "Values",
    fields: [
      { id: "x", name: "x", type: FIELD_TYPE.number, default: 0 },
      { id: "y", name: "y", type: FIELD_TYPE.number, default: 0 },
    ],
  });
  const inner = doc.addPrefab("inner");
  const innerRoot = doc.prefab(inner)?.root;
  if (!innerRoot) throw new Error("root");
  const source = doc.addInstance({ output: "out_main", prefab: inner, id: "source" });
  return { doc, koko, inner, innerRoot, source };
}
it("再びプレハブにしたあとも、元の System とインスタンスで足した System を解除時に残す", () => {
  const { doc, source } = setup();
  const a = doc.addSystem("root after", "");
  const b = doc.addSystem("source after", "");
  doc.setInstanceSystems(source, [{ id: a, enabled: true }]);
  doc.unpackPrefabInstance(source);
  doc.makePrefabFromEntity(source);
  doc.setInstanceSystems(source, [{ id: b, enabled: true }]);
  const before = expandPrefabs(doc.snapshot()).outputs[0]?.systems;
  doc.unpackPrefabInstance(source);
  expect(expandPrefabs(doc.snapshot()).outputs[0]?.systems).toEqual(before);
});
it("外側から適用した上書きは、入れ子自身を適用しても優先される", () => {
  const { doc, koko, inner, innerRoot } = setup();
  doc.addState(innerRoot, koko);
  const outer = doc.addPrefab("outer");
  const nested = doc.addPrefabEntity({
    prefab: outer,
    name: "nested",
    instanceOf: { prefab: inner },
    states: { [koko]: { x: 6 } },
  });
  const source = doc.addInstance({ output: "out_main", prefab: outer });
  doc.setField(`${source}/${nested}`, koko, "x", 9);
  doc.applyPrefabInstance(source);
  expect(
    expandPrefabs(doc.snapshot()).entities.find((e) => e.id === `${source}/${nested}`)?.states[koko]
      ?.x,
  ).toBe(9);
  doc.applyPrefabInstance(nested);
  expect(doc.prefabEntity(innerRoot)?.states[koko]?.x).toBe(9);
});
it("追加 KokoState を適用しても、同時に変えた別のフィールドを消さない", () => {
  const { doc, koko, source } = setup();
  doc.addState(source, koko, { x: 5, y: 6 });
  const remote = new ProjectDoc();
  Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(doc.doc));
  const before = Y.encodeStateVector(doc.doc);
  doc.applyPrefabInstance(source);
  remote.setField(source, koko, "y", 77);
  const a = Y.encodeStateAsUpdate(doc.doc, before),
    b = Y.encodeStateAsUpdate(remote.doc, before);
  Y.applyUpdate(doc.doc, b);
  Y.applyUpdate(remote.doc, a);
  expect(doc.snapshot()).toEqual(remote.snapshot());
  expect(expandPrefabs(doc.snapshot()).entities.find((e) => e.id === source)?.states[koko]?.y).toBe(
    77,
  );
});
it("System の適用とプレハブの名前変更が同時でも両方を保つ", () => {
  const { doc, inner, source } = setup();
  const s = doc.addSystem("added", "");
  doc.setInstanceSystems(source, [{ id: s, enabled: true }]);
  const remote = new ProjectDoc();
  Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(doc.doc));
  const before = Y.encodeStateVector(doc.doc);
  doc.applyPrefabInstance(source);
  remote.renamePrefab(inner, "renamed");
  const a = Y.encodeStateAsUpdate(doc.doc, before),
    b = Y.encodeStateAsUpdate(remote.doc, before);
  Y.applyUpdate(doc.doc, b);
  Y.applyUpdate(remote.doc, a);
  expect(doc.snapshot()).toEqual(remote.snapshot());
  expect(doc.prefab(inner)).toMatchObject({ name: "renamed", systems: [{ id: s, enabled: true }] });
});
