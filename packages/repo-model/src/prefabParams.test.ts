import { describe, expect, it } from "vitest";
import { BUILTIN } from "./builtins";
import { checkProjectReferences } from "./diagnostics/references";
import { checkProjectStructure } from "./diagnostics/structure";
import { fromFiles, toFiles } from "./files";
import { newParamName, paramsBrokenBy, paramsBrokenNote, prefabParamList } from "./prefabParams";
import { ProjectDoc } from "./projectDoc";
import type { PrefabParam, ProjectSnapshot } from "./schema";

/** Bullet のプレハブ：いちばん上（root）に Shot（speed・damage）、子（tip）に Shot を持つ */
function project(
  params: Record<string, PrefabParam>,
  over: Partial<ProjectSnapshot> = {},
): ProjectSnapshot {
  return {
    version: 1,
    name: "p",
    kokostates: [
      {
        id: "ks_shot",
        name: "Shot",
        fields: [
          { id: "f_speed", name: "speed", type: "number", default: 1 },
          { id: "f_damage", name: "damage", type: "number", default: 1 },
        ],
      },
    ],
    systems: [],
    materials: [],
    assets: [],
    outputs: [{ id: "out", name: "場", kind: "item", systems: [], keep: [] }],
    entities: [],
    folders: [],
    placement: {},
    prefabs: [{ id: "bullet", name: "Bullet", root: "root", systems: [], keep: [], params }],
    prefabEntities: [
      {
        id: "root",
        name: "弾",
        prefab: "bullet",
        parent: null,
        order: 0,
        states: { ks_shot: { f_speed: 5, f_damage: 2 }, [BUILTIN.Transform]: {} },
      },
      {
        id: "tip",
        name: "先",
        prefab: "bullet",
        parent: "root",
        order: 0,
        states: { ks_shot: { f_speed: 0, f_damage: 0 } },
      },
    ],
    ...over,
  };
}
const param = (over: Partial<PrefabParam> = {}): PrefabParam => ({
  name: "Speed",
  entity: "",
  koko: "ks_shot",
  field: "f_speed",
  required: false,
  order: 0,
  ...over,
});
const instance = (id: string, over: object = {}) => ({
  id,
  name: id,
  parent: null,
  output: "out",
  order: 0,
  states: {},
  instanceOf: { prefab: "bullet" },
  ...over,
});
const codes = (s: ProjectSnapshot) =>
  checkProjectReferences(s)
    .filter((d) => d.code.startsWith("prefab-param"))
    .map((d) => [d.code, d.subject.kind, d.subject.id]);

describe("プレハブのパラメータ", () => {
  it("並び順で返し、新しい名前は重ならないようにする", () => {
    const p = {
      params: { b: param({ name: "B", order: 2 }), a: param({ name: "Speed", order: 1 }) },
    };
    expect(prefabParamList(p).map((x) => x.id)).toEqual(["a", "b"]);
    expect(newParamName(p, "Damage")).toBe("Damage");
    expect(newParamName(p, "Speed")).toBe("Speed2");
  });

  it("指すものがそろい、名前が重ならなければ、問題を出さない（子の Entity のフィールドも指せる）", () => {
    expect(
      codes(
        project({
          a: param(),
          b: param({ name: "TipDamage", entity: "tip", field: "f_damage", order: 1 }),
        }),
      ),
    ).toEqual([]);
  });

  it("指す Entity・KokoState・フィールドがなければ、パラメータを問題にする", () => {
    expect(
      codes(
        project({
          a: param({ entity: "gone" }),
          b: param({ name: "B", koko: "ks_gone" }),
          c: param({ name: "C", field: "f_gone" }),
        }),
      ),
    ).toEqual([
      ["prefab-param-target-missing", "prefab", "bullet"],
      ["prefab-param-target-missing", "prefab", "bullet"],
      ["prefab-param-target-missing", "prefab", "bullet"],
    ]);
  });

  it("同じ名前のパラメータと、空の名前を問題にする", () => {
    expect(codes(project({ a: param(), b: param({ field: "f_damage", order: 1 }) }))).toEqual([
      ["prefab-param-name-collision", "prefab", "bullet"],
    ]);
    expect(codes(project({ a: param({ name: " " }) }))).toEqual([
      ["prefab-param-name-invalid", "prefab", "bullet"],
    ]);
  });

  it("置いたインスタンスが、必須のパラメータの値を決めていなければ、問題にする。省略できるものは問題にしない", () => {
    const params = {
      a: param({ required: true }),
      b: param({ name: "Damage", field: "f_damage", order: 1 }),
    };
    expect(codes(project(params, { entities: [instance("i1")] }))).toEqual([
      ["prefab-param-required", "entity", "i1"],
    ]);
    // 上書きで決めている（上書きの入れ物でも、インスタンスの Entity の値でもよい）
    expect(
      codes(
        project(params, {
          entities: [
            instance("i1", { prefabOverrides: { "": { states: { ks_shot: { f_speed: 9 } } } } }),
            instance("i2", { states: { ks_shot: { f_speed: 9 } } }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("子の Entity のフィールドを指す必須のパラメータは、その Entity の上書きで埋まる", () => {
    const params = { a: param({ required: true, entity: "tip" }) };
    expect(codes(project(params, { entities: [instance("i1")] }))).toHaveLength(1);
    expect(
      codes(
        project(params, {
          entities: [
            instance("i1", { prefabOverrides: { tip: { states: { ks_shot: { f_speed: 9 } } } } }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("いちばん上の Entity の Transform を指すパラメータは、必須でも問題にしない", () => {
    const params = {
      a: param({ name: "Position", koko: BUILTIN.Transform, field: "position", required: true }),
    };
    expect(
      codes(project(params, { entities: [instance("i1")] })).filter(
        (c) => c[0] === "prefab-param-required",
      ),
    ).toEqual([]);
  });

  it("プレハブの中に置いたインスタンスは、外側の必須のパラメータが指していれば埋まる。省略できるものでは埋まらない", () => {
    const inner = { a: param({ required: true }) };
    const gun = (outerRequired: boolean | null): ProjectSnapshot => {
      const p = project(inner);
      p.prefabs?.push({
        id: "gun",
        name: "Gun",
        root: "g_root",
        systems: [],
        keep: [],
        ...(outerRequired === null
          ? {}
          : {
              params: {
                o: param({ name: "BulletSpeed", entity: "g_bullet", required: outerRequired }),
              },
            }),
      });
      p.prefabEntities?.push(
        { id: "g_root", name: "銃", prefab: "gun", parent: null, order: 0, states: {} },
        {
          id: "g_bullet",
          name: "中の弾",
          prefab: "gun",
          parent: "g_root",
          order: 0,
          states: {},
          instanceOf: { prefab: "bullet" },
        },
      );
      return p;
    };
    expect(codes(gun(null))).toEqual([["prefab-param-required", "prefab", "gun"]]);
    expect(codes(gun(false))).toEqual([["prefab-param-required", "prefab", "gun"]]);
    expect(codes(gun(true))).toEqual([]);
  });

  it("プレハブのいちばん上の Entity が持つインスタンスの印（バリアント）には、必須の問題を出さない", () => {
    const p = project({ a: param({ required: true }) });
    p.prefabs?.push({ id: "red", name: "Red", root: "r_root", systems: [], keep: [] });
    p.prefabEntities?.push({
      id: "r_root",
      name: "赤い弾",
      prefab: "red",
      parent: null,
      order: 0,
      states: {},
      instanceOf: { prefab: "bullet" },
    });
    expect(codes(p)).toEqual([]);
  });
});

describe("パラメータが指すものを消すときの確かめ", () => {
  const p = project({
    a: param(),
    b: param({ name: "TipDamage", entity: "tip", field: "f_damage", order: 1 }),
  });
  const names = (r: Parameters<typeof paramsBrokenBy>[1]) =>
    paramsBrokenBy(p, r).map((x) => x.param.name);

  it("KokoState・フィールド・Entity から外す KokoState・Entity を消すと、指しているパラメータが分かる", () => {
    expect(names({ kind: "kokostate", koko: "ks_shot" })).toEqual(["Speed", "TipDamage"]);
    expect(names({ kind: "field", koko: "ks_shot", field: "f_damage" })).toEqual(["TipDamage"]);
    expect(names({ kind: "state", prefab: "bullet", entity: "root", koko: "ks_shot" })).toEqual([
      "Speed",
    ]);
    expect(names({ kind: "entity", prefab: "bullet", entity: "tip" })).toEqual(["TipDamage"]);
    // いちばん上を消すと、その下の Entity を指すものも含む
    expect(names({ kind: "entity", prefab: "bullet", entity: "root" })).toEqual([
      "Speed",
      "TipDamage",
    ]);
    expect(names({ kind: "entity", prefab: "other", entity: "tip" })).toEqual([]);
  });

  it("確認に足す文を作る。指すパラメータがなければ、空", () => {
    expect(paramsBrokenNote(p, { kind: "field", koko: "ks_shot", field: "f_gone" })).toBe("");
    expect(paramsBrokenNote(p, { kind: "field", koko: "ks_shot", field: "f_speed" })).toContain(
      "プレハブ「Bullet」の「Speed」",
    );
  });
});

describe("パラメータの保存", () => {
  const params = {
    a: param({ required: true, description: "弾の速さ" }),
    b: param({ name: "TipDamage", entity: "tip", field: "f_damage", order: 1 }),
  };

  it("Git のファイルにして読み直しても、そのまま残る", () => {
    expect(fromFiles(toFiles(project(params))).prefabs?.[0]?.params).toEqual(params);
  });

  it("共同編集の制作データに入れて取り出しても残り、updatePrefab で変えられる", () => {
    const doc = new ProjectDoc();
    doc.load(project(params));
    expect(doc.prefab("bullet")?.params).toEqual(params);
    const prefab = doc.prefab("bullet");
    if (!prefab) throw new Error("プレハブがありません");
    doc.updatePrefab({ ...prefab, params: { a: { ...params.a, name: "Velocity" } } });
    expect(doc.snapshot().prefabs?.[0]?.params).toEqual({ a: { ...params.a, name: "Velocity" } });
    // パラメータをすべて消すと、キーごとなくなる
    const { params: _gone, ...rest } = doc.prefab("bullet") ?? prefab;
    doc.updatePrefab(rest);
    expect(doc.prefab("bullet")?.params).toBeUndefined();
  });
});

describe("予約語", () => {
  it("Prefab という名前のリソースは問題にする。大文字・小文字は区別し、フォルダは対象にしない", () => {
    const p = project({});
    p.kokostates.push({ id: "ks_p", name: "Prefab", fields: [] });
    p.kokostates.push({ id: "ks_q", name: "prefab", fields: [] });
    p.folders = [{ id: "fo", name: "Prefab", parent: null }];
    p.placement = { ks_q: "fo" };
    expect(
      checkProjectStructure(p)
        .filter((d) => d.code === "reserved-name")
        .map((d) => d.subject.id),
    ).toEqual(["ks_p"]);
  });
});
