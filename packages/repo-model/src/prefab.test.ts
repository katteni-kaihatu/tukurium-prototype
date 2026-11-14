import { FIELD_TYPE } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BUILTIN } from "./builtins";
import { ProjectDependencyGraph } from "./dependencyGraph";
import { checkProjectReferences } from "./diagnostics/references";
import { fromFiles, toFiles } from "./files";
import {
  expandedEntityId,
  expandPrefabs,
  isInstanceRoot,
  PrefabExpansionCache,
  prefabProblems,
} from "./prefab";
import { ProjectDoc } from "./projectDoc";
import { ResourcePathIndex } from "./resourcePath";
import { emptyProject } from "./samples";

const OUT = "out_main";

/** 的のプレハブ：いちばん上（Mesh）の下に、芯（いちばん上を指す参照を持つ）がある */
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
  doc.setField(root, BUILTIN.Transform, "scale", [2, 2, 2]);
  const core = doc.addPrefabEntity({
    prefab,
    name: "芯",
    states: { [BUILTIN.Transform]: { position: [0, 1, 0] }, [link]: { f_to: root } },
  });
  doc.updatePrefab({
    ...def,
    systems: [{ id: sys, enabled: true }],
    keep: [{ entity: core, koko: link, field: "f_hp" }],
  });
  return { doc, prefab, root, core, link, sys };
}

describe("プレハブのリソース", () => {
  it("空のプレハブは、いちばん上の Entity を一つ持つ", () => {
    const doc = new ProjectDoc();
    doc.load(emptyProject("p"));
    const id = doc.addPrefab("的");
    const def = doc.prefab(id);
    expect(def).toMatchObject({ id, name: "的", systems: [], keep: [] });
    expect(doc.prefabEntities(id).map((e) => [e.id, e.parent])).toEqual([[def?.root, null]]);
    // アウトプットの Entity には混ざらない
    expect(doc.entities()).toEqual([]);
  });

  it("名前を変えても動かしても、インスタンスとのつながりは切れない", () => {
    const { doc, prefab } = targetProject();
    const inst = doc.addInstance({ output: OUT, prefab });
    const folder = doc.addFolder("部品", null);
    doc.renamePrefab(prefab, "まと");
    doc.moveResource(prefab, folder);
    expect(doc.entity(inst)?.instanceOf).toEqual({ prefab });
    expect(ResourcePathIndex.fromSnapshot(doc.snapshot()).pathOf(prefab)).toBe("/部品/まと.prefab");
    expect(expandPrefabs(doc.snapshot()).entities).toHaveLength(2);
    // 同じ場所の、ほかのリソースと同じ名前にはできない
    const other = doc.addPrefab("べつ");
    doc.moveResource(other, folder);
    expect(() => doc.renamePrefab(other, "まと")).toThrow();
  });

  it("消すと、インスタンスは残り、問題として出る", () => {
    const { doc, prefab } = targetProject();
    const inst = doc.addInstance({ output: OUT, prefab });
    doc.removePrefab(prefab);
    expect(doc.prefabs()).toEqual([]);
    expect(doc.prefabEntities()).toEqual([]);
    const snap = doc.snapshot();
    expect(expandPrefabs(snap).entities.map((e) => e.id)).toEqual([inst]);
    expect(prefabProblems(snap)).toEqual([
      { kind: "missing", owner: { kind: "output", id: OUT }, entity: inst, prefab },
    ]);
    expect(checkProjectReferences(snap).map((d) => [d.code, d.subject])).toContainEqual([
      "missing-prefab",
      { kind: "entity", id: inst },
    ]);
  });

  it("ファイルと共同編集を通しても、同じ中身になる", () => {
    const { doc, prefab, root, core } = targetProject();
    doc.addInstance({ output: OUT, prefab, id: "ent_inst" });
    const snap = doc.snapshot();
    const files = toFiles(snap);
    expect(files[`prefabs/${prefab}.json`]).toBeDefined();
    expect(files[`prefabs/${prefab}/entities/${root}.json`]).toBeDefined();
    expect(files[`prefabs/${prefab}/entities/${core}.json`]).toBeDefined();
    expect(JSON.parse(files[`outputs/${OUT}/entities/ent_inst.json`] ?? "{}").instanceOf).toEqual({
      prefab,
    });
    const loaded = new ProjectDoc();
    loaded.load(fromFiles(files));
    expect(toFiles(loaded.snapshot())).toEqual(files);

    const other = new ProjectDoc();
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(doc.doc));
    expect(other.snapshot()).toEqual(snap);
    // プレハブの中の値は、フィールドごとの後勝ち：別のフィールドを同時に変えても、両方が残る
    const [va, vb] = [Y.encodeStateVector(doc.doc), Y.encodeStateVector(other.doc)];
    doc.setField(core, BUILTIN.Transform, "position", [1, 1, 1]);
    other.setField(core, BUILTIN.Transform, "scale", [3, 3, 3]);
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(doc.doc, vb));
    Y.applyUpdate(doc.doc, Y.encodeStateAsUpdate(other.doc, va));
    expect(doc.prefabEntity(core)?.states[BUILTIN.Transform]).toMatchObject({
      position: [1, 1, 1],
      scale: [3, 3, 3],
    });
    expect(other.snapshot()).toEqual(doc.snapshot());
  });

  it("KokoState・マテリアル・System を消すと、プレハブの中からも外れる", () => {
    const { doc, prefab, core, link, sys } = targetProject();
    const mat = doc.addMaterial("赤");
    doc.addState(core, BUILTIN.Mesh, { shape: "sphere", material: mat });
    doc.removeMaterial(mat);
    expect(doc.prefabEntity(core)?.states[BUILTIN.Mesh]?.material).toBeUndefined();
    doc.removeKokoState(link);
    expect(doc.prefabEntity(core)?.states[link]).toBeUndefined();
    doc.removeSystem(sys);
    expect(doc.prefab(prefab)?.systems).toEqual([]);
  });

  it("インスタンスを消すと、その中を指す「維持」の印も外れる", () => {
    const { doc, prefab, core, link } = targetProject();
    const inst = doc.addInstance({ output: OUT, prefab });
    const keeper = doc.addEntity({ output: OUT, name: "ほか" });
    const output = doc.output(OUT);
    if (!output) throw new Error("アウトプットがありません");
    doc.updateOutput({
      ...output,
      keep: [
        { entity: expandedEntityId(inst, core), koko: link, field: "f_hp" },
        { entity: keeper, koko: BUILTIN.Transform, field: "position" },
      ],
    });
    doc.removeEntity(inst);
    expect(doc.output(OUT)?.keep.map((k) => k.entity)).toEqual([keeper]);
  });

  it("Entity の ID に「/」は使えない", () => {
    const doc = new ProjectDoc();
    doc.load(emptyProject("p"));
    expect(() => doc.addEntity({ output: OUT, name: "x", id: "a/b" })).toThrow();
  });
});

describe("プレハブの展開", () => {
  it("インスタンスが、プレハブの中身になる。ID は決まった作り方になる", () => {
    const { doc, prefab, root, core, link } = targetProject();
    const a = doc.addInstance({ output: OUT, prefab, position: [1, 0, 0], id: "ent_a" });
    const b = doc.addInstance({
      output: OUT,
      prefab,
      position: [2, 0, 0],
      id: "ent_b",
      name: "的B",
    });
    doc.addEntity({ output: OUT, name: "床", id: "ent_floor" });
    const snap = doc.snapshot();
    const expanded = expandPrefabs(snap);
    expect(expanded.entities.map((e) => e.id)).toEqual([
      "ent_a",
      `ent_a/${core}`,
      "ent_b",
      `ent_b/${core}`,
      "ent_floor",
    ]);
    const rootA = expanded.entities.find((e) => e.id === a);
    const coreA = expanded.entities.find((e) => e.id === expandedEntityId(a, core));
    const rootB = expanded.entities.find((e) => e.id === b);
    // いちばん上の Entity：名前・場所・向き・大きさはインスタンスのもの、ほかの KokoState はプレハブのもの
    expect(rootA).toMatchObject({ name: "的", parent: null, output: OUT });
    expect(rootA?.states[BUILTIN.Transform]).toMatchObject({
      position: [1, 0, 0],
      scale: [2, 2, 2],
    });
    expect(rootA?.states[BUILTIN.Mesh]).toMatchObject({ shape: "box" });
    expect(rootB?.name).toBe("的B");
    expect(rootB?.states[BUILTIN.Transform]).toMatchObject({ position: [2, 0, 0] });
    // 中の Entity：親と、Entity の参照は、インスタンスの中の ID に付け替わる
    expect(coreA).toMatchObject({ name: "芯", parent: a, output: OUT });
    expect(coreA?.states[link]).toEqual({ f_to: a, f_hp: 3 });
    expect(coreA?.states[BUILTIN.Transform]).toMatchObject({ position: [0, 1, 0] });
    // どこから来たかが分かる。展開したあとは、インスタンスの印を持たない
    expect(rootA?.origin).toEqual({ instance: a, prefab, entity: root });
    expect(coreA?.origin).toEqual({ instance: a, prefab, entity: core });
    expect(rootA && isInstanceRoot(rootA)).toBe(true);
    expect(coreA && isInstanceRoot(coreA)).toBe(false);
    expect(expanded.entities.every((e) => e.instanceOf === undefined)).toBe(true);
    expect(expanded.entities.find((e) => e.id === "ent_floor")?.origin).toBeUndefined();
    // 展開したものをもう一度展開しても変わらない。元の制作データは変えない
    expect(expandPrefabs(expanded)).toBe(expanded);
    expect(snap).toEqual(doc.snapshot());
  });

  it("インスタンスがなければ、渡したものをそのまま返す", () => {
    const { doc } = targetProject();
    const snap = doc.snapshot();
    expect(expandPrefabs(snap)).toBe(snap);
  });

  it("プレハブを直すと、すべてのインスタンスに反映される", () => {
    const { doc, prefab, core, link } = targetProject();
    const ids = ["ent_a", "ent_b", "ent_c"].map((id) =>
      doc.addInstance({ output: OUT, prefab, id }),
    );
    doc.setField(core, link, "f_hp", 9);
    const added = doc.addPrefabEntity({ prefab, name: "飾り", parent: core });
    const expanded = expandPrefabs(doc.snapshot());
    for (const id of ids) {
      const c = expanded.entities.find((e) => e.id === expandedEntityId(id, core));
      expect(c?.states[link]?.f_hp).toBe(9);
      expect(expanded.entities.find((e) => e.id === expandedEntityId(id, added))?.parent).toBe(
        expandedEntityId(id, core),
      );
    }
  });

  it("System と「維持」の印を、アウトプットに足し合わせる", () => {
    const { doc, prefab, core, link, sys } = targetProject();
    const own = doc.addSystem("Own", "export default system({});\n");
    const other = doc.addSystem("Other", "export default system({});\n");
    // もう一つのプレハブ：同じ System（切）と、別の System を持つ
    const second = doc.addPrefab("箱");
    const secondDef = doc.prefab(second);
    if (!secondDef) throw new Error("プレハブがありません");
    doc.updatePrefab({
      ...secondDef,
      systems: [
        { id: other, enabled: true },
        { id: sys, enabled: false },
      ],
    });
    const output = doc.output(OUT);
    if (!output) throw new Error("アウトプットがありません");
    doc.updateOutput({ ...output, systems: [{ id: own, enabled: true }] });
    // Hierarchy では「箱」が先。System は、先に出てくるインスタンスのプレハブのものから足す
    const box = doc.addInstance({ output: OUT, prefab: second, id: "ent_box" });
    const a = doc.addInstance({ output: OUT, prefab, id: "ent_a" });
    doc.addInstance({ output: OUT, prefab, id: "ent_b" });
    const merged = expandPrefabs(doc.snapshot()).outputs.find((o) => o.id === OUT);
    // アウトプットのものが先。同じ System は一つにまとめ、どれかのプレハブで「入」なら「入」
    expect(merged?.systems).toEqual([
      { id: own, enabled: true },
      { id: other, enabled: true },
      { id: sys, enabled: true },
    ]);
    expect(merged?.keep).toEqual([
      { entity: expandedEntityId(a, core), koko: link, field: "f_hp" },
      { entity: `ent_b/${core}`, koko: link, field: "f_hp" },
    ]);
    // アウトプットにも同じ System があれば、アウトプットの「入・切」が勝つ（アウトプットの画面から切れる）
    doc.updateOutput({
      ...output,
      systems: [
        { id: sys, enabled: false },
        { id: own, enabled: true },
      ],
    });
    expect(expandPrefabs(doc.snapshot()).outputs.find((o) => o.id === OUT)?.systems).toEqual([
      { id: sys, enabled: false },
      { id: own, enabled: true },
      { id: other, enabled: true },
    ]);
    expect(doc.entity(box)?.instanceOf).toEqual({ prefab: second });
  });

  it("入れ子のプレハブも、たどって展開する", () => {
    const { doc, prefab: piece, root: pieceRoot, core, link, sys } = targetProject();
    const board = doc.addPrefab("盤");
    const boardRoot = doc.prefab(board)?.root ?? "";
    const p1 = doc.addPrefabEntity({
      prefab: board,
      name: "駒1",
      instanceOf: { prefab: piece },
      states: { [BUILTIN.Transform]: { position: [1, 0, 0] } },
    });
    // 盤の中から、入れ子の駒の中の Entity を指す
    const pointer = doc.addPrefabEntity({
      prefab: board,
      name: "指す",
      states: { [link]: { f_to: expandedEntityId(p1, core) } },
    });
    const inst = doc.addInstance({ output: OUT, prefab: board, id: "ent_board" });
    const expanded = expandPrefabs(doc.snapshot());
    const byId = new Map(expanded.entities.map((e) => [e.id, e]));
    expect([...byId.keys()]).toEqual([
      inst,
      `${inst}/${p1}`,
      `${inst}/${p1}/${core}`,
      `${inst}/${pointer}`,
    ]);
    const nested = byId.get(expandedEntityId(inst, p1));
    // 入れ子のインスタンス：名前と場所は盤の中の Entity のもの、ほかは駒のプレハブのもの
    expect(nested).toMatchObject({ name: "駒1", parent: inst });
    expect(nested?.states[BUILTIN.Transform]).toMatchObject({ position: [1, 0, 0] });
    expect(nested?.states[BUILTIN.Mesh]).toMatchObject({ shape: "box" });
    expect(nested?.origin).toEqual({ instance: inst, prefab: piece, entity: pieceRoot });
    const nestedCore = byId.get(expandedEntityId(inst, p1, core));
    expect(nestedCore?.parent).toBe(expandedEntityId(inst, p1));
    expect(nestedCore?.states[link]?.f_to).toBe(expandedEntityId(inst, p1));
    expect(byId.get(expandedEntityId(inst, pointer))?.states[link]?.f_to).toBe(
      expandedEntityId(inst, p1, core),
    );
    expect(byId.get(inst)?.origin).toEqual({ instance: inst, prefab: board, entity: boardRoot });
    // 中のプレハブの System と「維持」の印も届く
    const output = expanded.outputs.find((o) => o.id === OUT);
    expect(output?.systems).toEqual([{ id: sys, enabled: true }]);
    expect(output?.keep).toEqual([
      { entity: expandedEntityId(inst, p1, core), koko: link, field: "f_hp" },
    ]);
    // 駒を直すと、盤の中の駒にも反映される
    doc.setField(core, link, "f_hp", 7);
    const again = expandPrefabs(doc.snapshot());
    expect(
      again.entities.find((e) => e.id === expandedEntityId(inst, p1, core))?.states[link]?.f_hp,
    ).toBe(7);
  });

  it("自分を含むプレハブ（輪）は、展開せずに問題として出す", () => {
    const doc = new ProjectDoc();
    doc.load(emptyProject("輪"));
    const a = doc.addPrefab("A");
    const b = doc.addPrefab("B");
    const inA = doc.addPrefabEntity({ prefab: a, name: "Bを置く", instanceOf: { prefab: b } });
    const inB = doc.addPrefabEntity({ prefab: b, name: "Aを置く" });
    const self = doc.addPrefabEntity({ prefab: a, name: "自分" });
    // 読み込みや共同編集で輪が入った場合も、展開と診断は止まらない。
    const broken = doc.snapshot();
    for (const e of broken.prefabEntities ?? [])
      if (e.id === inB || e.id === self) e.instanceOf = { prefab: a };
    doc.load(broken);
    const inst = doc.addInstance({ output: OUT, prefab: a, id: "ent_a" });
    const snap = doc.snapshot();
    // A → B まで開き、B の中の A は開かない（そのままの Entity として残る）
    expect(expandPrefabs(snap).entities.map((e) => e.id)).toEqual([
      inst,
      `${inst}/${inA}`,
      `${inst}/${inA}/${inB}`,
      `${inst}/${self}`,
    ]);
    const problems = prefabProblems(snap);
    expect(problems).toContainEqual({
      kind: "cycle",
      owner: { kind: "prefab", id: a },
      entity: self,
      prefab: a,
      path: [a],
    });
    expect(problems).toContainEqual({
      kind: "cycle",
      owner: { kind: "prefab", id: a },
      entity: inA,
      prefab: b,
      path: [b, a],
    });
    expect(problems).toContainEqual({
      kind: "cycle",
      owner: { kind: "prefab", id: b },
      entity: inB,
      prefab: a,
      path: [a, b],
    });
    const cycles = checkProjectReferences(snap).filter((d) => d.code === "prefab-cycle");
    expect(cycles.map((d) => d.subject)).toEqual(
      expect.arrayContaining([
        { kind: "prefab", id: a },
        { kind: "prefab", id: b },
      ]),
    );
    // B を先に開いても、同じ形になる（輪を避けて作ったものは取っておかない）
    const cache = new PrefabExpansionCache();
    const instB = doc.addInstance({ output: OUT, prefab: b, id: "ent_b" });
    const both = expandPrefabs(doc.snapshot(), { cache });
    expect(both.entities.filter((e) => e.id.startsWith(instB)).map((e) => e.id)).toEqual([
      instB,
      `${instB}/${inB}`,
      `${instB}/${inB}/${inA}`,
      `${instB}/${inB}/${self}`,
    ]);
    expect(both.entities.filter((e) => e.id.startsWith(inst)).map((e) => e.id)).toEqual([
      inst,
      `${inst}/${inA}`,
      `${inst}/${inA}/${inB}`,
      `${inst}/${self}`,
    ]);
  });

  it("展開した Entity を指す参照と「維持」の印は、問題にならない", () => {
    const { doc, prefab, core, link } = targetProject();
    const inst = doc.addInstance({ output: OUT, prefab, id: "ent_a" });
    const coreId = expandedEntityId(inst, core);
    doc.addEntity({ output: OUT, name: "指す", states: { [link]: { f_to: coreId } } });
    const output = doc.output(OUT);
    if (!output) throw new Error("アウトプットがありません");
    doc.updateOutput({ ...output, keep: [{ entity: coreId, koko: link, field: "f_hp" }] });
    expect(checkProjectReferences(doc.snapshot())).toEqual([]);
    // プレハブからその Entity が消えると、指している側の問題になる
    doc.removePrefab(prefab);
    expect(checkProjectReferences(doc.snapshot()).map((d) => d.code)).toEqual(
      expect.arrayContaining(["missing-prefab", "missing-entity", "keep-invalid"]),
    );
  });

  it("取っておいた結果は、変わったプレハブだけ作り直す", () => {
    const { doc, prefab: piece, core, link } = targetProject();
    const board = doc.addPrefab("盤");
    doc.addPrefabEntity({ prefab: board, name: "駒", instanceOf: { prefab: piece } });
    const box = doc.addPrefab("箱");
    doc.addInstance({ output: OUT, prefab: board, id: "ent_board" });
    doc.addInstance({ output: OUT, prefab: box, id: "ent_box" });
    const cache = new PrefabExpansionCache();
    const first = expandPrefabs(doc.snapshot(), { cache });
    expect(cache.builds).toBe(3);
    // 何も変えていなければ、作り直さない。結果は同じ
    expect(expandPrefabs(doc.snapshot(), { cache })).toEqual(first);
    expect(cache.builds).toBe(3);
    // インスタンスを足しても、プレハブは作り直さない。前からあるインスタンスも展開し直さない
    expect(cache.stamped).toBe(2);
    doc.addInstance({ output: OUT, prefab: board, id: "ent_board2" });
    const more = expandPrefabs(doc.snapshot(), { cache });
    expect(cache.builds).toBe(3);
    expect(cache.stamped).toBe(3);
    expect(more.entities.find((e) => e.id === "ent_board")).toBe(
      first.entities.find((e) => e.id === "ent_board"),
    );
    // インスタンスを動かすと、そのインスタンスだけを展開し直す
    doc.setField("ent_box", BUILTIN.Transform, "position", [5, 0, 0]);
    const moved = expandPrefabs(doc.snapshot(), { cache });
    expect(cache.stamped).toBe(4);
    expect(moved).toEqual(expandPrefabs(doc.snapshot()));
    // 駒を変えると、駒と、駒を使っている盤だけを作り直す（箱はそのまま）。盤のインスタンスだけを展開し直す
    doc.setField(core, link, "f_hp", 1);
    const changed = expandPrefabs(doc.snapshot(), { cache });
    expect(cache.builds).toBe(5);
    expect(cache.stamped).toBe(6);
    expect(changed).toEqual(expandPrefabs(doc.snapshot()));
    // インスタンスを消すと、取っておいた分も捨てる
    doc.removeEntity("ent_board2");
    expandPrefabs(doc.snapshot(), { cache });
    expect([...cache.stamps.keys()].sort()).toEqual(["ent_board", "ent_box"]);
    // フィールドの型が変わると、参照の付け替えが変わるので、すべて作り直す
    const def = doc.kokostate(link);
    if (!def) throw new Error("KokoState がありません");
    doc.updateKokoState({
      ...def,
      fields: def.fields.map((f) => (f.id === "f_to" ? { ...f, type: FIELD_TYPE.string } : f)),
    });
    expandPrefabs(doc.snapshot(), { cache });
    expect(cache.builds).toBe(8);
  });

  it("依存グラフ：インスタンスはプレハブに、プレハブは中で使うものに依存する", () => {
    const { doc, prefab, link, sys } = targetProject();
    const inst = doc.addInstance({ output: OUT, prefab, id: "ent_a" });
    const graph = ProjectDependencyGraph.fromSnapshot(doc.snapshot());
    expect(graph.dependenciesOf({ kind: "entity", id: inst })).toContainEqual({
      kind: "prefab",
      id: prefab,
    });
    expect(graph.dependenciesOf({ kind: "prefab", id: prefab })).toEqual(
      expect.arrayContaining([
        { kind: "system", id: sys },
        { kind: "kokostate", id: link },
      ]),
    );
    // System を変えると、プレハブ・インスタンス・アウトプットまで届く
    expect(graph.transitiveDependents([{ kind: "system", id: sys }])).toEqual(
      expect.arrayContaining([
        { kind: "prefab", id: prefab },
        { kind: "entity", id: inst },
        { kind: "output", id: OUT },
      ]),
    );
  });
});
