import { FIELD_TYPE, type FieldSchemas } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BUILTIN } from "./builtins";
import { checkProjectReferences } from "./diagnostics/references";
import { expandedEntityId, expandPrefabs } from "./prefab";
import { planPrefabFromEntity } from "./prefabFromEntity";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";
import type { ProjectSnapshot } from "./schema";

const OUT = "out_main";
/** ID は、互いに含み合わない書き方にする（テストで、文字の置き換えで比べるため） */
const ID = {
  base: "ent_dai",
  target: "ent_mato",
  core: "ent_shin",
  deco: "ent_kazari",
  pole: "ent_shichu",
  other: "ent_hoka",
};

/**
 * 台の下の「的」（芯・飾り・支柱つき）と、的の外の「ほか」。
 * Link は、Entity の参照（to）・数（hp）・入れ子の値の中の参照（many：Entity の並び、pair：レコード）を持つ
 */
function project() {
  const doc = new ProjectDoc();
  doc.load(emptyProject("的当て"));
  const link = doc.addKokoState("Link");
  doc.updateKokoState({
    id: link,
    name: "Link",
    fields: [
      { id: "f_to", name: "to", type: FIELD_TYPE.entity, default: undefined },
      { id: "f_hp", name: "hp", type: FIELD_TYPE.number, default: 3 },
      { id: "f_many", name: "many", type: "EntityRef[]", default: [] },
      { id: "f_pair", name: "pair", type: "{ a: EntityRef; n: number }", default: { a: "", n: 0 } },
    ],
  });
  const schemas: FieldSchemas = {
    [link]: {
      f_many: { kind: "list", item: { kind: "ref", target: "entity" } },
      f_pair: {
        kind: "record",
        fields: [
          { name: "a", schema: { kind: "ref", target: "entity" }, optional: false },
          { name: "n", schema: { kind: "number" }, optional: false },
        ],
      },
    },
  };
  const finder = doc.addSystem("Finder", `const core = world.find("${ID.core}");\n`);
  const mover = doc.addSystem("Mover", `const target = world.find("${ID.target}");\n`);
  doc.addEntity({ output: OUT, name: "台", id: ID.base });
  doc.addEntity({
    output: OUT,
    name: "的",
    id: ID.target,
    parent: ID.base,
    states: {
      [BUILTIN.Transform]: { position: [3, 1, 0], rotation: [0, 45, 0], scale: [2, 2, 2] },
      [BUILTIN.Mesh]: { shape: "box" },
      [link]: { f_to: ID.core, f_hp: 5, f_many: [ID.deco, ID.target, ID.other] },
    },
  });
  doc.addEntity({
    output: OUT,
    name: "芯",
    id: ID.core,
    parent: ID.target,
    states: {
      [BUILTIN.Transform]: { position: [0, 1, 0] },
      [link]: { f_to: ID.target, f_pair: { a: ID.pole, n: 1 } },
    },
  });
  doc.addEntity({ output: OUT, name: "飾り", id: ID.deco, parent: ID.core });
  doc.addEntity({
    output: OUT,
    name: "支柱",
    id: ID.pole,
    parent: ID.target,
    states: { [link]: { f_to: ID.other } },
  });
  doc.addEntity({
    output: OUT,
    name: "ほか",
    id: ID.other,
    states: {
      [link]: {
        f_to: ID.core,
        f_many: [ID.target, ID.deco, ID.base],
        f_pair: { a: ID.pole, n: 2 },
      },
    },
  });
  const output = doc.output(OUT);
  if (!output) throw new Error("アウトプットがありません");
  doc.updateOutput({
    ...output,
    systems: [
      { id: finder, enabled: true },
      { id: mover, enabled: false },
    ],
    keep: [
      { entity: ID.target, koko: BUILTIN.Transform, field: "position" },
      { entity: ID.target, koko: link, field: "f_hp" },
      { entity: ID.core, koko: link, field: "f_hp" },
      { entity: ID.other, koko: link, field: "f_hp" },
    ],
  });
  return { doc, link, schemas, finder, mover };
}

/** 展開した Entity を、ID の対応を通して比べられる形にする（origin は比べない） */
function comparable(snap: ProjectSnapshot, schemas: FieldSchemas, rename: Map<string, string>) {
  const expanded = expandPrefabs(snap, { schemas });
  // ID そのものと、その中（「/」でつないだ、インスタンスの中の ID）を置き換える
  const swap = <T>(value: T): T => {
    let text = JSON.stringify(value);
    for (const [from, to] of rename)
      text = text.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`"${from}/`, `"${to}/`);
    return JSON.parse(text) as T;
  };
  const output = expanded.outputs.find((o) => o.id === OUT);
  const entities = swap(
    expanded.entities.map(({ id, name, parent, output, order, states }) => ({
      id,
      name,
      parent,
      output,
      order,
      states,
    })),
  ).sort((a, b) => (a.id < b.id ? -1 : 1));
  const keep = swap(output?.keep ?? [])
    .map((k) => `${k.entity} ${k.koko} ${k.field}`)
    .sort();
  return { entities, keep, systems: output?.systems };
}

describe("アウトプットの Entity からプレハブを作る（ADR 0076）", () => {
  it("選んだ Entity は、ID・名前・親・並び順・Transform を持ったまま、インスタンスになる", () => {
    const { doc, schemas, link } = project();
    const before = doc.entity(ID.target);
    const plan = doc.makePrefabFromEntity(ID.target, { schemas });
    const after = doc.entity(ID.target);
    expect(after).toEqual({
      id: ID.target,
      name: "的",
      parent: ID.base,
      output: OUT,
      order: before?.order,
      states: { [BUILTIN.Transform]: before?.states[BUILTIN.Transform] },
      instanceOf: { prefab: plan.prefab.id },
    });
    // 中の Entity は、アウトプットからなくなり、新しい ID でプレハブに入る
    expect(
      doc
        .entities()
        .map((e) => e.id)
        .sort(),
    ).toEqual([ID.base, ID.other, ID.target].sort());
    const inside = doc.prefabEntities(plan.prefab.id);
    expect(inside.map((e) => e.name).sort()).toEqual(["的", "芯", "飾り", "支柱"].sort());
    const old = new Set(Object.values(ID));
    expect(inside.some((e) => old.has(e.id))).toBe(false);
    // 元の ID → プレハブの中の ID の対応が返る
    expect(plan.moved.map((m) => [m.from, m.name, m.depth])).toEqual([
      [ID.target, "的", 0],
      [ID.core, "芯", 1],
      [ID.deco, "飾り", 2],
      [ID.pole, "支柱", 1],
    ]);
    const to = new Map(plan.moved.map((m) => [m.from, m.to]));
    expect(doc.prefab(plan.prefab.id)).toMatchObject({ name: "的", root: to.get(ID.target) });
    expect(plan.moved.map((m) => m.expanded)).toEqual([
      ID.target,
      expandedEntityId(ID.target, to.get(ID.core) ?? ""),
      expandedEntityId(ID.target, to.get(ID.deco) ?? ""),
      expandedEntityId(ID.target, to.get(ID.pole) ?? ""),
    ]);
    // いちばん上の Entity：向きと大きさは写し、場所は原点。ほかの KokoState は、ここに移る
    const root = doc.prefabEntity(to.get(ID.target) ?? "");
    expect(root?.parent).toBeNull();
    expect(root?.states[BUILTIN.Transform]).toEqual({
      position: [0, 0, 0],
      rotation: [0, 45, 0],
      scale: [2, 2, 2],
    });
    expect(root?.states[BUILTIN.Mesh]).toMatchObject({ shape: "box" });
    expect(root?.states[link]?.f_hp).toBe(5);
    expect(doc.prefabEntity(to.get(ID.deco) ?? "")?.parent).toBe(to.get(ID.core));
    expect(doc.prefabEntity(to.get(ID.core) ?? "")?.parent).toBe(to.get(ID.target));
  });

  it("参照が切れない：プレハブの中どうしは中の ID に、外からは展開した ID に書き換える（入れ子の値の中も）", () => {
    const { doc, schemas, link } = project();
    const plan = doc.makePrefabFromEntity(ID.target, { schemas });
    const to = new Map(plan.moved.map((m) => [m.from, m.to]));
    const at = new Map(plan.moved.map((m) => [m.from, m.expanded]));
    // プレハブの中どうし
    const root = doc.prefabEntity(to.get(ID.target) ?? "");
    expect(root?.states[link]).toMatchObject({
      f_to: to.get(ID.core),
      // 外の Entity（ほか）を指す参照は、そのまま
      f_many: [to.get(ID.deco), to.get(ID.target), ID.other],
    });
    expect(doc.prefabEntity(to.get(ID.core) ?? "")?.states[link]).toMatchObject({
      f_to: to.get(ID.target),
      f_pair: { a: to.get(ID.pole), n: 1 },
    });
    // 外から：親（的）への参照は、そのまま。中の Entity への参照は、展開した ID
    expect(doc.entity(ID.other)?.states[link]).toMatchObject({
      f_to: at.get(ID.core),
      f_many: [ID.target, at.get(ID.deco), ID.base],
      f_pair: { a: at.get(ID.pole), n: 2 },
    });
    // 書き換えた所は、計画に出る（どの Entity の、どのフィールド）
    expect(
      plan.rewrites.map((r) => [r.entityName, `${r.kokoName}.${r.fieldName}`, r.targets]),
    ).toEqual([
      ["ほか", "Link.to", [{ from: ID.core, to: at.get(ID.core) }]],
      ["ほか", "Link.many", [{ from: ID.deco, to: at.get(ID.deco) }]],
      ["ほか", "Link.pair", [{ from: ID.pole, to: at.get(ID.pole) }]],
    ]);
    // プレハブの中から、外の Entity を指している所も分かる
    expect(plan.outsideRefs.map((r) => [r.entityName, r.fieldName, r.targetName])).toEqual([
      ["的", "many", "ほか"],
      ["支柱", "to", "ほか"],
    ]);
    // 参照の問題は出ない
    expect(checkProjectReferences(doc.snapshot(), schemas)).toEqual([]);
  });

  it("「維持」の印：プレハブに移した Entity のものはプレハブへ移し、Transform の印とほかの Entity の印は残す", () => {
    const { doc, schemas, link } = project();
    const plan = doc.makePrefabFromEntity(ID.target, { schemas });
    const to = new Map(plan.moved.map((m) => [m.from, m.to]));
    expect(doc.output(OUT)?.keep).toEqual([
      { entity: ID.target, koko: BUILTIN.Transform, field: "position" },
      { entity: ID.other, koko: link, field: "f_hp" },
    ]);
    expect(doc.prefab(plan.prefab.id)?.keep).toEqual([
      { entity: to.get(ID.target), koko: link, field: "f_hp" },
      { entity: to.get(ID.core), koko: link, field: "f_hp" },
    ]);
    expect(plan.keepMoved.map((k) => [k.entityName, k.from.entity, k.to.entity])).toEqual([
      ["的", ID.target, to.get(ID.target)],
      ["芯", ID.core, to.get(ID.core)],
    ]);
  });

  it("変換の前とあとで、展開した結果（値・親子・「維持」の印・System）が同じ", () => {
    const { doc, schemas } = project();
    const before = doc.snapshot();
    const plan = doc.makePrefabFromEntity(ID.target, { schemas });
    const rename = new Map(plan.moved.map((m) => [m.from, m.expanded]));
    expect(comparable(doc.snapshot(), schemas, new Map())).toEqual(
      comparable(before, schemas, rename),
    );
  });

  it("変換した Entity のインスタンスをもう一つ置くと、同じ中身が出る", () => {
    const { doc, schemas, link } = project();
    const plan = doc.makePrefabFromEntity(ID.target, { schemas });
    const second = doc.addInstance({ output: OUT, prefab: plan.prefab.id, position: [9, 0, 0] });
    const expanded = expandPrefabs(doc.snapshot(), { schemas }).entities;
    // インスタンスごとの中身。インスタンスの ID は「*」にして比べる。
    // いちばん上の Entity の親と Transform は、インスタンスごとのものなので外す
    const of = (instance: string) =>
      JSON.parse(
        JSON.stringify(
          expanded
            .filter((e) => e.origin?.instance === instance)
            .map((e) => {
              if (e.id !== instance)
                return { id: e.id, name: e.name, parent: e.parent, states: e.states };
              const { [BUILTIN.Transform]: _transform, ...states } = e.states;
              return { id: e.id, name: e.name, parent: null, states };
            }),
        ).replaceAll(`"${instance}`, '"*'),
      );
    expect(of(second)).toHaveLength(4);
    expect(of(second)).toEqual(of(ID.target));
    // いちばん上の Entity：向きと大きさは写り、場所は置いた所
    const root = expanded.find((e) => e.id === second);
    expect(root?.states[BUILTIN.Transform]).toEqual({
      position: [9, 0, 0],
      rotation: [0, 45, 0],
      scale: [2, 2, 2],
    });
    // 中の参照は、そのインスタンスの中を指す
    const core = plan.moved.find((m) => m.from === ID.core)?.to ?? "";
    expect(root?.states[link]?.f_to).toBe(expandedEntityId(second, core));
  });

  it("スクリプトが、ID の変わる Entity を ID で探していたら、注意に出る（書き換えはしない）", () => {
    const { doc, schemas, finder } = project();
    const code = doc.code(finder)?.toString();
    const plan = doc.makePrefabFromEntity(ID.target, { schemas });
    // 的（親）の ID は変わらないので、Mover は出ない
    expect(plan.scriptMentions).toEqual([
      {
        system: finder,
        name: "Finder",
        entities: [
          {
            id: ID.core,
            name: "芯",
            expanded: plan.moved.find((m) => m.from === ID.core)?.expanded,
          },
        ],
      },
    ]);
    expect(doc.code(finder)?.toString()).toBe(code);
  });

  it("System は、選んだものだけをプレハブにも入れる。アウトプットの並びは変えない", () => {
    const { doc, schemas, finder, mover } = project();
    const systems = doc.output(OUT)?.systems;
    const none = doc.planPrefabFromEntity(ID.target, { schemas });
    expect(none.ok && none.plan.prefab.systems).toEqual([]);
    const plan = doc.makePrefabFromEntity(ID.target, { schemas, systems: [mover, "sys_nai"] });
    expect(plan.prefab.systems).toEqual([{ id: mover, enabled: false }]);
    expect(doc.output(OUT)?.systems).toEqual(systems);
    // 展開しても、アウトプットの「入・切」が勝つ
    expect(expandPrefabs(doc.snapshot()).outputs[0]?.systems).toEqual([
      { id: finder, enabled: true },
      { id: mover, enabled: false },
    ]);
  });

  it("計画だけでは、制作データは変わらない。確認に出した ID のまま変換できる", () => {
    const { doc, schemas } = project();
    const before = doc.snapshot();
    const shown = doc.planPrefabFromEntity(ID.target, { schemas });
    if (!shown.ok) throw new Error(shown.reason);
    expect(doc.snapshot()).toEqual(before);
    const ids = {
      prefab: shown.plan.prefab.id,
      entities: Object.fromEntries(shown.plan.moved.map((m) => [m.from, m.to])),
    };
    const done = doc.makePrefabFromEntity(ID.target, { schemas, ids });
    expect(done.prefab.id).toBe(shown.plan.prefab.id);
    expect(done.moved).toEqual(shown.plan.moved);
  });

  it("プレハブの名前は、Entity の名前から。同じ場所にあれば、番号を付ける", () => {
    const { doc, schemas } = project();
    doc.addPrefab("的");
    const plan = doc.makePrefabFromEntity(ID.target, { schemas });
    expect(plan.prefab.name).toBe("的 2");
    // リソースの名前に使えない名前の Entity は、「プレハブ」にする
    doc.renameEntity(ID.other, "a/b");
    expect(doc.makePrefabFromEntity(ID.other, { schemas }).prefab.name).toBe("プレハブ");
    expect(() => doc.makePrefabFromEntity(ID.base, { schemas, name: "的" })).toThrow(/同じ場所/);
  });

  it("一つの更新で届く（共同編集の相手に、途中の形が見えない）", () => {
    const { doc, schemas } = project();
    const other = new ProjectDoc();
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(doc.doc));
    const updates: Uint8Array[] = [];
    doc.doc.on("update", (u: Uint8Array) => updates.push(u));
    doc.makePrefabFromEntity(ID.target, { schemas });
    expect(updates).toHaveLength(1);
    Y.applyUpdate(other.doc, updates[0] as Uint8Array);
    expect(other.snapshot()).toEqual(doc.snapshot());
  });

  it("中にインスタンスがあれば、入れ子のインスタンスとしてプレハブに移す。その中を指す参照と印も切れない", () => {
    const { doc, schemas, link } = project();
    const piece = doc.addPrefab("駒");
    const tip = doc.addPrefabEntity({ prefab: piece, name: "先", states: { [link]: {} } });
    const nested = doc.addInstance({ output: OUT, prefab: piece, parent: ID.core, id: "ent_koma" });
    const tipId = expandedEntityId(nested, tip);
    doc.setField(ID.other, link, "f_to", tipId);
    doc.setField(ID.pole, link, "f_to", tipId);
    const output = doc.output(OUT);
    if (!output) throw new Error("アウトプットがありません");
    doc.updateOutput({ ...output, keep: [{ entity: tipId, koko: link, field: "f_hp" }] });
    const before = doc.snapshot();

    const plan = doc.makePrefabFromEntity(ID.target, { schemas });
    const to = new Map(plan.moved.map((m) => [m.from, m.to]));
    const inner = to.get(nested) ?? "";
    expect(doc.prefabEntity(inner)?.instanceOf).toEqual({ prefab: piece });
    expect(doc.entity(ID.other)?.states[link]?.f_to).toBe(expandedEntityId(ID.target, inner, tip));
    expect(doc.prefabEntity(to.get(ID.pole) ?? "")?.states[link]?.f_to).toBe(
      expandedEntityId(inner, tip),
    );
    expect(doc.prefab(plan.prefab.id)?.keep).toEqual([
      { entity: expandedEntityId(inner, tip), koko: link, field: "f_hp" },
    ]);
    expect(doc.output(OUT)?.keep).toEqual([]);
    const rename = new Map(plan.moved.map((m) => [m.from, m.expanded]));
    expect(comparable(doc.snapshot(), schemas, new Map())).toEqual(
      comparable(before, schemas, rename),
    );
    expect(checkProjectReferences(doc.snapshot(), schemas)).toEqual([]);
  });

  it("変換できない場合は、わけを添えて断る", () => {
    const { doc, schemas } = project();
    const reason = (id: string) => {
      const result = doc.planPrefabFromEntity(id, { schemas });
      return result.ok ? null : result.reason;
    };
    expect(reason("ent_nai")).toBe("Entity がありません");
    // すでにインスタンス・プレハブから来た Entity・プレハブの中の Entity
    const plan = doc.makePrefabFromEntity(ID.target, { schemas });
    const core = plan.moved.find((m) => m.from === ID.core);
    expect(reason(ID.target)).toMatch(/すでにプレハブのインスタンス/);
    expect(reason(core?.expanded ?? "")).toMatch(/プレハブから来た Entity/);
    expect(reason(core?.to ?? "")).toMatch(/プレハブの中の Entity/);
    expect(() => doc.makePrefabFromEntity(ID.target, { schemas })).toThrow(/すでに/);
    // インスタンスの中の Entity の下に足した Entity がある（込み入った形）
    doc.addEntity({ output: OUT, name: "足した", parent: core?.expanded ?? "" });
    const snap = doc.snapshot();
    const base = planPrefabFromEntity(snap, ID.base, { schemas });
    expect(base.ok ? null : base.reason).toMatch(
      /中のインスタンスの下に足した Entity（「足した」）/,
    );
    // ライブラリのアウトプット（古いデータなどで、Entity が入っていたとき）
    const lib = doc.addOutput("部品集", "library");
    const stray = planPrefabFromEntity(
      {
        ...snap,
        entities: [
          ...snap.entities,
          { id: "ent_lib", name: "x", parent: null, output: lib, order: 0, states: {} },
        ],
        outputs: doc.snapshot().outputs,
      },
      "ent_lib",
    );
    expect(stray.ok ? null : stray.reason).toMatch(/ライブラリ/);
  });
});
