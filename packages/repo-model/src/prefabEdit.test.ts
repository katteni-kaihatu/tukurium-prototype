import { FIELD_TYPE } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import { BUILTIN } from "./builtins";
import { checkProjectReferences } from "./diagnostics/references";
import {
  expandedEntityId,
  expandPrefabForEdit,
  expandPrefabs,
  isInstanceRoot,
  PrefabExpansionCache,
} from "./prefab";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";

const OUT = "out_main";

/** 的のプレハブ：いちばん上（Mesh）の下に、芯（いちばん上を指す参照を持つ）と、飾りがある */
function targetProject() {
  const doc = new ProjectDoc();
  doc.load(emptyProject("プレハブ"));
  const link = doc.addKokoState("Link");
  doc.updateKokoState({
    id: link,
    name: "Link",
    fields: [
      { id: "f_to", name: "to", type: FIELD_TYPE.entity, default: undefined },
      { id: "f_hp", name: "hp", type: FIELD_TYPE.number, default: 3 },
    ],
  });
  const sys = doc.addSystem("TargetSystem", "export default system({});\n");
  const prefab = doc.addPrefab("的");
  const def = doc.prefab(prefab);
  if (!def) throw new Error("プレハブがありません");
  const root = def.root;
  doc.addState(root, BUILTIN.Mesh, { shape: "box" });
  const core = doc.addPrefabEntity({
    prefab,
    name: "芯",
    states: { [BUILTIN.Transform]: { position: [0, 1, 0] }, [link]: { f_to: root } },
  });
  const deco = doc.addPrefabEntity({ prefab, name: "飾り" });
  doc.updatePrefab({
    ...def,
    systems: [{ id: sys, enabled: true }],
    keep: [{ entity: core, koko: link, field: "f_hp" }],
  });
  return { doc, prefab, root, core, deco, link, sys };
}

const tree = (doc: ProjectDoc, prefab: string) =>
  doc.prefabEntities(prefab).map((e) => [e.name, e.parent, e.order]);

describe("プレハブを、編集用の並びにする", () => {
  it("中の Entity は、そのままの ID。アウトプットの Entity の並びと同じ形になる", () => {
    const { doc, prefab, root, core, deco, link, sys } = targetProject();
    const view = expandPrefabForEdit(doc.snapshot(), prefab);
    expect(view?.entities.map((e) => [e.id, e.parent, e.output])).toEqual([
      [root, null, prefab],
      [core, root, prefab],
      [deco, root, prefab],
    ]);
    // 参照は、付け替えない（プレハブの中の ID のまま）
    expect(view?.entities.find((e) => e.id === core)?.states[link]?.f_to).toBe(root);
    expect(view?.entities.every((e) => e.origin === undefined)).toBe(true);
    // このプレハブを表すアウトプットを、一つだけ持つ（ID はプレハブの ID）
    expect(view?.outputs).toEqual([
      {
        id: prefab,
        name: "的",
        kind: "item",
        systems: [{ id: sys, enabled: true }],
        keep: [{ entity: core, koko: link, field: "f_hp" }],
      },
    ]);
    // もう一度展開しても、変わらない
    expect(view && expandPrefabs(view).entities).toEqual(view?.entities);
  });

  it("プレハブか、いちばん上の Entity がなければ null", () => {
    const { doc, prefab, root } = targetProject();
    expect(expandPrefabForEdit(doc.snapshot(), "pf_none")).toBeNull();
    const snap = doc.snapshot();
    const broken = {
      ...snap,
      prefabEntities: snap.prefabEntities?.filter((e) => e.id !== root),
    };
    expect(expandPrefabForEdit(broken, prefab)).toBeNull();
  });

  it("親が見つからない Entity は、いちばん上の Entity の下に出す", () => {
    const { doc, prefab, root, core } = targetProject();
    const snap = doc.snapshot();
    const broken = {
      ...snap,
      prefabEntities: snap.prefabEntities?.map((e) =>
        e.id === core ? { ...e, parent: "ent_gone" } : e,
      ),
    };
    expect(expandPrefabForEdit(broken, prefab)?.entities.find((e) => e.id === core)?.parent).toBe(
      root,
    );
  });

  it("入れ子のインスタンスの中は、「その Entity の ID / 中の ID」で展開する", () => {
    const { doc, prefab: piece, root: pieceRoot, core, link, sys } = targetProject();
    const board = doc.addPrefab("盤");
    const slot = doc.addPrefabEntity({ prefab: board, name: "駒", instanceOf: { prefab: piece } });
    const view = expandPrefabForEdit(doc.snapshot(), board);
    const inner = view?.entities.find((e) => e.id === expandedEntityId(slot, core));
    expect(inner).toMatchObject({
      parent: slot,
      output: board,
      origin: { instance: slot, prefab: piece, entity: core },
    });
    // 中の参照は、その入れ子のインスタンスを指す
    expect(inner?.states[link]?.f_to).toBe(slot);
    const nested = view?.entities.find((e) => e.id === slot);
    expect(nested && isInstanceRoot(nested)).toBe(true);
    expect(nested?.origin).toEqual({ instance: slot, prefab: piece, entity: pieceRoot });
    // 中のプレハブの System と「維持」の印も、足し合わせる
    expect(view?.outputs[0]?.systems).toEqual([{ id: sys, enabled: true }]);
    expect(view?.outputs[0]?.keep).toEqual([
      { entity: expandedEntityId(slot, core), koko: link, field: "f_hp" },
    ]);
  });

  it("自分を含むプレハブ（輪）は、展開しない", () => {
    const { doc, prefab: a } = targetProject();
    const b = doc.addPrefab("B");
    const inA = doc.addPrefabEntity({ prefab: a, name: "B を置く", instanceOf: { prefab: b } });
    const inB = doc.addPrefabEntity({ prefab: b, name: "A を置く" });
    const self = doc.addPrefabEntity({ prefab: a, name: "自分" });
    const broken = doc.snapshot();
    for (const e of broken.prefabEntities ?? [])
      if (e.id === inB || e.id === self) e.instanceOf = { prefab: a };
    doc.load(broken);
    const ids = expandPrefabForEdit(doc.snapshot(), a)?.entities.map((e) => e.id);
    // B の中の「A を置く」と、自分のインスタンスは、中身に置き換えない
    expect(ids).toContain(expandedEntityId(inA, inB));
    expect(ids?.some((id) => id.startsWith(`${inA}/${inB}/`))).toBe(false);
    expect(ids?.some((id) => id.startsWith(`${self}/`))).toBe(false);
  });

  it("取っておいた結果を使っても、同じ並びになる", () => {
    const { doc, prefab: piece, core, link } = targetProject();
    const board = doc.addPrefab("盤");
    doc.addPrefabEntity({ prefab: board, name: "駒", instanceOf: { prefab: piece } });
    const cache = new PrefabExpansionCache();
    const first = expandPrefabForEdit(doc.snapshot(), board, { cache });
    expect(expandPrefabForEdit(doc.snapshot(), board, { cache })).toEqual(first);
    const builds = cache.builds;
    expandPrefabForEdit(doc.snapshot(), board, { cache });
    expect(cache.builds).toBe(builds);
    doc.setField(core, link, "f_hp", 9);
    expect(expandPrefabForEdit(doc.snapshot(), board, { cache })).toEqual(
      expandPrefabForEdit(doc.snapshot(), board),
    );
  });
});

describe("プレハブの中の Entity を直す", () => {
  it("直すと、すべてのインスタンスに反映される", () => {
    const { doc, prefab, root, core, link } = targetProject();
    const insts = ["ent_a", "ent_b", "ent_c"].map((id, i) =>
      doc.addInstance({ output: OUT, prefab, id, position: [i * 2, 0, 0] }),
    );
    doc.setField(core, link, "f_hp", 7);
    doc.renameEntity(core, "まんなか");
    doc.addState(root, BUILTIN.Collider);
    const added = doc.addPrefabEntity({ prefab, name: "足した", parent: core });
    const expanded = expandPrefabs(doc.snapshot());
    for (const inst of insts) {
      const at = (id: string) => expanded.entities.find((e) => e.id === expandedEntityId(inst, id));
      expect(at(core)).toMatchObject({ name: "まんなか", states: { [link]: { f_hp: 7 } } });
      expect(at(added)?.parent).toBe(expandedEntityId(inst, core));
      expect(expanded.entities.find((e) => e.id === inst)?.states[BUILTIN.Collider]).toBeDefined();
    }
    // 消すと、どのインスタンスからも消える
    doc.removeEntity(core);
    expect(expandPrefabs(doc.snapshot()).entities.filter((e) => e.id.includes(core))).toEqual([]);
  });

  it("並べ替えと、親の付け替えができる。兄弟は、同じプレハブの中で数える", () => {
    const { doc, prefab, root, core, deco } = targetProject();
    const other = doc.addPrefab("べつ");
    doc.addPrefabEntity({ prefab: other, name: "よその子" });
    doc.addEntity({ output: OUT, name: "アウトプットの Entity" });
    doc.placeEntity(deco, root, 0);
    expect(tree(doc, prefab)).toEqual([
      ["的", null, 0],
      ["飾り", root, 0],
      ["芯", root, 1],
    ]);
    doc.placeEntity(deco, core, 0);
    expect(doc.prefabEntity(deco)?.parent).toBe(core);
    // 親なしにすると、いちばん上の Entity の下に付く
    doc.setParent(deco, null);
    expect(doc.prefabEntity(deco)?.parent).toBe(root);
    doc.placeEntity(core, null, 5);
    expect(tree(doc, prefab)).toEqual([
      ["的", null, 0],
      ["飾り", root, 0],
      ["芯", root, 1],
    ]);
    // よそのプレハブと、アウトプットの並びは変わらない
    expect(tree(doc, other).map((e) => e[2])).toEqual([0, 0]);
    expect(doc.entities(OUT).map((e) => e.order)).toEqual([0]);
  });

  it("いちばん上の Entity は、消せず、ほかの下に付けられず、複製できない", () => {
    const { doc, prefab, root, core } = targetProject();
    expect(() => doc.removeEntity(root)).toThrow("消せません");
    expect(() => doc.setParent(root, core)).toThrow("付けられません");
    expect(() => doc.placeEntity(root, core, 0)).toThrow("付けられません");
    expect(() => doc.duplicateEntity(root, true)).toThrow("複製できません");
    expect(doc.prefab(prefab)?.root).toBe(root);
    expect(doc.prefabEntities(prefab)).toHaveLength(3);
  });

  it("輪になる付け替えと、持ち主をまたぐ付け替えは断る", () => {
    const { doc, prefab, core, deco } = targetProject();
    const other = doc.addPrefab("べつ");
    const outside = doc.addPrefabEntity({ prefab: other, name: "よその子" });
    const plain = doc.addEntity({ output: OUT, name: "アウトプットの Entity" });
    doc.setParent(deco, core);
    expect(() => doc.setParent(core, deco)).toThrow("自分の子孫");
    expect(() => doc.setParent(deco, outside)).toThrow("同じプレハブ");
    expect(() => doc.setParent(deco, plain)).toThrow("同じプレハブ");
    expect(() => doc.setParent(plain, deco)).toThrow("同じアウトプット");
    expect(doc.prefabEntity(deco)?.prefab).toBe(prefab);
  });

  it("消すと、中の Entity も消え、そこを指す「維持」の印も外れる", () => {
    const { doc, prefab, root, core, deco, link } = targetProject();
    doc.setParent(deco, core);
    const inst = doc.addInstance({ output: OUT, prefab, id: "ent_a" });
    const output = doc.output(OUT);
    if (!output) throw new Error("アウトプットがありません");
    doc.updateOutput({
      ...output,
      keep: [
        { entity: expandedEntityId(inst, core), koko: link, field: "f_hp" },
        { entity: inst, koko: BUILTIN.Transform, field: "position" },
      ],
    });
    doc.removeEntity(core);
    expect(doc.prefabEntities(prefab).map((e) => e.id)).toEqual([root]);
    expect(doc.prefab(prefab)?.keep).toEqual([]);
    // インスタンスの中のその Entity を指していた、アウトプットの印も外れる
    expect(doc.output(OUT)?.keep).toEqual([
      { entity: inst, koko: BUILTIN.Transform, field: "position" },
    ]);
    expect(checkProjectReferences(doc.snapshot())).toEqual([]);
  });

  it("複製すると、同じ親の下に写しができる。中も含めて写せる", () => {
    const { doc, prefab, root, core, deco, link } = targetProject();
    doc.setParent(deco, core);
    const copy = doc.duplicateEntity(core, true);
    if (!copy) throw new Error("複製できませんでした");
    expect(doc.prefabEntity(copy)).toMatchObject({
      name: "芯 のコピー",
      parent: root,
      prefab,
      states: { [link]: { f_to: root } },
    });
    expect(
      doc
        .prefabEntities(prefab)
        .filter((e) => e.parent === copy)
        .map((e) => e.name),
    ).toEqual(["飾り"]);
    // これだけ複製：中は写さない
    const single = doc.duplicateEntity(core, false);
    expect(doc.prefabEntities(prefab).filter((e) => e.parent === single)).toEqual([]);
    expect(doc.entities()).toEqual([]);
  });

  it("アウトプットのインスタンスを複製すると、同じプレハブのインスタンスが増える", () => {
    const { doc, prefab } = targetProject();
    const inst = doc.addInstance({ output: OUT, prefab, id: "ent_a", position: [1, 2, 3] });
    const kid = doc.addEntity({ output: OUT, name: "子", parent: inst });
    const copy = doc.duplicateEntity(inst, true);
    if (!copy) throw new Error("複製できませんでした");
    expect(doc.entity(copy)).toMatchObject({
      name: "的 のコピー",
      parent: null,
      instanceOf: { prefab },
      states: { [BUILTIN.Transform]: { position: [1, 2, 3] } },
    });
    const kids = doc.entities(OUT).filter((e) => e.parent === copy);
    expect(kids.map((e) => e.name)).toEqual(["子"]);
    expect(kids[0]?.id).not.toBe(kid);
    expect(doc.prefabEntities(prefab)).toHaveLength(3);
  });
});

describe("プレハブの中の問題", () => {
  const problems = (doc: ProjectDoc) =>
    checkProjectReferences(doc.snapshot()).map((d) => [d.code, d.subject, d.location]);

  it("中の Entity が指すリソースと Entity がないことを、プレハブを相手に出す", () => {
    const { doc, prefab, root, core, link } = targetProject();
    expect(problems(doc)).toEqual([]);
    doc.setField(root, BUILTIN.Mesh, "material", "mat_gone");
    doc.setField(core, link, "f_to", "ent_gone");
    const subject = { kind: "prefab", id: prefab };
    expect(problems(doc)).toEqual([
      [
        "missing-resource",
        subject,
        { kind: "property", path: ["entities", root, BUILTIN.Mesh, "material"] },
      ],
      ["missing-entity", subject, { kind: "property", path: ["entities", core, link, "f_to"] }],
    ]);
    expect(checkProjectReferences(doc.snapshot())[0]?.message).toBe(
      "プレハブ「的」の中の「的」の Mesh.material に指定したマテリアルがありません",
    );
  });

  it("入れ子のインスタンスの中の Entity と、アウトプットの Entity は指せる", () => {
    const { doc, prefab: piece, core, link } = targetProject();
    const board = doc.addPrefab("盤");
    const slot = doc.addPrefabEntity({ prefab: board, name: "駒", instanceOf: { prefab: piece } });
    const plain = doc.addEntity({ output: OUT, name: "外の Entity" });
    doc.addPrefabEntity({
      prefab: board,
      name: "中を指す",
      states: { [link]: { f_to: expandedEntityId(slot, core) } },
    });
    doc.addPrefabEntity({ prefab: board, name: "外を指す", states: { [link]: { f_to: plain } } });
    expect(problems(doc)).toEqual([]);
  });

  it("KokoState の定義・System がないこと、「維持」の印がない値を指していることを出す", () => {
    const { doc, prefab, core, link, sys } = targetProject();
    const def = doc.prefab(prefab);
    if (!def) throw new Error("プレハブがありません");
    doc.updatePrefab({
      ...def,
      systems: [
        { id: sys, enabled: true },
        { id: "sys_gone", enabled: true },
      ],
      keep: [
        { entity: core, koko: link, field: "f_hp" },
        { entity: core, koko: link, field: "f_gone" },
        { entity: "ent_gone", koko: link, field: "f_hp" },
      ],
    });
    // 定義のない KokoState を持たせる（取り込みやマージで起こりうる）
    doc.restorePrefab(
      doc.prefab(prefab) ?? def,
      doc
        .prefabEntities(prefab)
        .map((e) => (e.id === core ? { ...e, states: { ...e.states, ks_gone: {} } } : e)),
    );
    const subject = { kind: "prefab", id: prefab };
    expect(problems(doc)).toEqual([
      ["missing-kokostate", subject, { kind: "property", path: ["entities", core, "ks_gone"] }],
      ["prefab-system-missing", subject, { kind: "property", path: ["systems", "sys_gone"] }],
      ["prefab-keep-invalid", subject, { kind: "property", path: ["keep", core, link, "f_gone"] }],
      [
        "prefab-keep-invalid",
        subject,
        { kind: "property", path: ["keep", "ent_gone", link, "f_hp"] },
      ],
    ]);
  });
});
