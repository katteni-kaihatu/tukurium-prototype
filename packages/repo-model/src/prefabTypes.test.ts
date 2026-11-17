import { describe, expect, it } from "vitest";
import { checkProjectReferences } from "./diagnostics/references";
import { fromFiles, toFiles } from "./files";
import {
  inheritedParamCollisions,
  newPrefabImportName,
  prefabChain,
  prefabFitsType,
  prefabInstanceFitsType,
  prefabTypeInfo,
} from "./prefabTypes";
import { ProjectDoc } from "./projectDoc";
import type { PrefabParam, ProjectSnapshot } from "./schema";

const defs = new Map([
  [
    "ks_shot",
    {
      fields: [
        { id: "f_speed", name: "speed", type: "number", default: 1 },
        { id: "f_damage", name: "damage", type: "number", default: 1 },
        { id: "f_label", name: "label", type: "string", default: "" },
      ],
    },
  ],
]);
const param = (name: string, field: string, required = false, order = 0): PrefabParam => ({
  name,
  entity: "",
  koko: "ks_shot",
  field,
  required,
  order,
});

/**
 * 駒（Speed は必須・Damage は省略できる）と、そのバリアントと、同じ構造の別のプレハブ。
 * バリアントは、いちばん上の Entity が、元のプレハブのインスタンスになっている（手で作った制作データ）。
 */
function project(): ProjectSnapshot {
  const base = { a: param("Speed", "f_speed", true), b: param("Damage", "f_damage", false, 1) };
  const prefab = (id: string, params?: Record<string, PrefabParam>) => ({
    id,
    name: id,
    root: `${id}_root`,
    systems: [],
    keep: [],
    ...(params ? { params } : {}),
  });
  const root = (id: string, of?: string) => ({
    id: `${id}_root`,
    name: id,
    prefab: id,
    parent: null,
    order: 0,
    states: {},
    ...(of ? { instanceOf: { prefab: of } } : {}),
  });
  return {
    version: 1,
    name: "p",
    kokostates: [],
    systems: [],
    materials: [],
    assets: [],
    outputs: [],
    entities: [],
    folders: [],
    placement: {},
    prefabs: [
      prefab("koma", base),
      // 省略できるパラメータを足したバリアント
      prefab("aka", { c: param("Label", "f_label") }),
      // 必須のパラメータを足したバリアント
      prefab("ou", { c: param("Label", "f_label", true) }),
      // バリアントのバリアント
      prefab("akaou", {}),
      // 同じ構造の別のプレハブ
      prefab("betsu", base),
      // 元と同じ名前のパラメータを足したバリアント
      prefab("dup", { c: param("Speed", "f_label") }),
    ],
    prefabEntities: [
      root("koma"),
      root("aka", "koma"),
      root("ou", "koma"),
      root("akaou", "aka"),
      root("betsu"),
      root("dup", "koma"),
    ],
  };
}
const info = (id: string) => {
  const found = prefabTypeInfo(project(), defs, id);
  if (!found) throw new Error(`${id} がありません`);
  return found;
};

describe("プレハブ型の中身", () => {
  it("印は、自分と、たどれるすべての元のプレハブの ID", () => {
    expect(prefabChain(project(), "koma")).toEqual(["koma"]);
    expect(prefabChain(project(), "akaou")).toEqual(["akaou", "aka", "koma"]);
    expect(prefabChain(project(), "nai")).toEqual([]);
  });

  it("元をたどって輪になっていても、止まる", () => {
    const p = project();
    const root = p.prefabEntities?.find((e) => e.id === "koma_root");
    if (root) root.instanceOf = { prefab: "akaou" };
    expect(prefabChain(p, "akaou")).toEqual(["akaou", "aka", "koma"]);
  });

  it("バリアントは、元のパラメータを受け継ぎ、自分のものをあとに足す", () => {
    expect(info("aka").params.map((p) => [p.name, p.required, p.type, p.owner])).toEqual([
      ["Speed", true, "number", "koma"],
      ["Damage", false, "number", "koma"],
      ["Label", false, "string", "aka"],
    ]);
    expect(info("akaou").params.map((p) => p.name)).toEqual(["Speed", "Damage", "Label"]);
  });

  it("指す先のないパラメータは、型が分からないものとして残す", () => {
    const p = project();
    const koma = p.prefabs?.find((x) => x.id === "koma");
    if (koma?.params) koma.params.a = { ...koma.params.a, field: "f_gone" } as PrefabParam;
    expect(prefabTypeInfo(p, defs, "koma")?.params[0]).toMatchObject({
      type: null,
      fieldName: null,
    });
  });
});

describe("プレハブ型に当てはまるか", () => {
  it("そのプレハブと、パラメータの合うバリアントは当てはまる", () => {
    expect(prefabFitsType(info("koma"), info("koma"))).toBe(true);
    expect(prefabFitsType(info("aka"), info("koma"))).toBe(true);
    expect(prefabFitsType(info("akaou"), info("koma"))).toBe(true);
    expect(prefabFitsType(info("akaou"), info("aka"))).toBe(true);
  });

  it("必須のパラメータを足したバリアントは当てはまらない", () => {
    expect(prefabFitsType(info("ou"), info("koma"))).toBe(false);
  });

  it("同じ構造の別のプレハブと、元のプレハブは当てはまらない", () => {
    expect(prefabFitsType(info("betsu"), info("koma"))).toBe(false);
    expect(prefabFitsType(info("koma"), info("aka"))).toBe(false);
  });

  it("インスタンス型は、印だけで決まる：必須のパラメータを足したバリアントのインスタンスも当てはまる", () => {
    expect(prefabInstanceFitsType(info("ou"), info("koma"))).toBe(true);
    expect(prefabInstanceFitsType(info("betsu"), info("koma"))).toBe(false);
    expect(prefabInstanceFitsType(info("koma"), info("ou"))).toBe(false);
  });

  it("バリアントで足したパラメータの名前が、元のものと重なっていれば分かる", () => {
    expect(inheritedParamCollisions(info("dup"))).toEqual(["Speed"]);
    expect(inheritedParamCollisions(info("aka"))).toEqual([]);
  });
});

describe("KokoState が import するプレハブ", () => {
  it("初めの名前は、プレハブの名前。KokoState やほかの import と重なるなら、Prefab を付ける", () => {
    expect(newPrefabImportName(["Gun"], [], "Koma")).toBe("Koma");
    expect(newPrefabImportName(["Bullet"], [], "Bullet")).toBe("BulletPrefab");
    expect(newPrefabImportName(["Bullet"], [{ name: "BulletPrefab" }], "Bullet")).toBe(
      "BulletPrefab2",
    );
    // 型の文で書けない名前は、書ける形にする
    expect(newPrefabImportName([], [], "赤い駒")).toBe("Prefab");
    expect(newPrefabImportName([], [], "Red Koma")).toBe("RedKoma");
  });

  it("import するプレハブは、共同編集の制作データと、Git のファイルに残る", () => {
    const p = project();
    const imports = [{ prefab: "koma", name: "Koma" }];
    p.kokostates = [{ id: "ks_k", name: "K", fields: [], prefabImports: imports }];
    expect(fromFiles(toFiles(p)).kokostates[0]?.prefabImports).toEqual(imports);
    const doc = new ProjectDoc();
    doc.load(p);
    expect(doc.kokostate("ks_k")?.prefabImports).toEqual(imports);
    const def = doc.kokostate("ks_k");
    if (!def) throw new Error("KokoState がありません");
    doc.updateKokoState({ ...def, prefabImports: [...imports, { prefab: "aka", name: "Aka" }] });
    expect(doc.snapshot().kokostates[0]?.prefabImports?.map((i) => i.name)).toEqual([
      "Koma",
      "Aka",
    ]);
    const { prefabImports: _gone, ...rest } = doc.kokostate("ks_k") ?? def;
    doc.updateKokoState(rest);
    expect(doc.kokostate("ks_k")?.prefabImports).toBeUndefined();
  });

  it("プレハブがない・名前が使えない・名前が重なる import と、「なし」を受け入れないインスタンス型を問題にする", () => {
    const p = project();
    p.kokostates = [
      { id: "ks_koma", name: "Koma", fields: [] },
      {
        id: "ks_k",
        name: "K",
        fields: [{ id: "f", name: "made", type: "InstanceOf<A>", default: undefined }],
        prefabImports: [
          { prefab: "koma", name: "A" },
          { prefab: "aka", name: "A" },
          { prefab: "betsu", name: "Koma" },
          { prefab: "ou", name: "1x" },
          { prefab: "gone", name: "Gone" },
        ],
      },
    ];
    const codes = checkProjectReferences(p, {
      ks_k: { f: { kind: "ref", target: "entity", prefab: "koma" } },
    })
      .filter((d) => d.subject.id === "ks_k")
      .map((d) => d.code);
    expect(codes).toEqual([
      "prefab-import-name-collision",
      "prefab-import-name-collision",
      "prefab-import-name-invalid",
      "missing-prefab-import",
      "prefab-instance-needs-undefined",
    ]);
  });

  it("プレハブ型のフィールドの値は、当てはまるプレハブだけ。インスタンス型のフィールドは、制作データでは「なし」", () => {
    const p = project();
    p.kokostates = [
      {
        id: "ks_k",
        name: "K",
        fields: [
          { id: "f", name: "prefab", type: "Koma | undefined", default: undefined },
          { id: "g", name: "made", type: "InstanceOf<Koma> | undefined", default: undefined },
        ],
        prefabImports: [{ prefab: "koma", name: "Koma" }],
      },
    ];
    p.outputs = [{ id: "out", name: "場", kind: "item", systems: [], keep: [] }];
    const entity = (id: string, values: Record<string, string>) => ({
      id,
      name: id,
      parent: null,
      output: "out",
      order: 0,
      states: { ks_k: values },
    });
    p.entities = [
      entity("ok", { f: "aka" }),
      entity("required", { f: "ou" }),
      entity("other", { f: "betsu" }),
      entity("gone", { f: "nai" }),
      entity("authored", { g: "ok" }),
    ];
    const undef = { kind: "undefined" as const };
    const found = checkProjectReferences(p, {
      ks_k: {
        f: { kind: "union", options: [{ kind: "ref", target: "prefab", prefab: "koma" }, undef] },
        g: { kind: "union", options: [{ kind: "ref", target: "entity", prefab: "koma" }, undef] },
      },
    })
      .filter((d) => d.subject.kind === "entity")
      .map((d) => [d.code, d.subject.id]);
    expect(found).toEqual([
      ["prefab-type-mismatch", "required"],
      ["prefab-type-mismatch", "other"],
      ["missing-resource", "gone"],
      ["prefab-instance-authored", "authored"],
    ]);
  });
});
