import type { ValueSchema } from "@tukurium/eks";
import { emptyProject, type ProjectSnapshot } from "@tukurium/repo-model";
import { hostApiDeclarations } from "@tukurium/runtime";
import { describe, expect, it } from "vitest";
import { TypeChecker } from "./checker";
import { nodeTypeCheckerOptions } from "./node";

/**
 * KokoState のフィールドの型に、プレハブ型・インスタンス型を書く（ADR 0082）。KokoState の「import するプレハブ」で
 * 付けた名前で指し、スキーマには、その型のプレハブの ID が入る。
 */
const checker = new TypeChecker(nodeTypeCheckerOptions());
const host = hostApiDeclarations();

/** 駒（Koma）と、そのバリアント（Aka）と、フィールドを持つ KokoState「K」 */
function project(
  types: string[],
  imports = [
    { prefab: "pf_koma", name: "Koma" },
    { prefab: "pf_aka", name: "Aka" },
  ],
): ProjectSnapshot {
  const p = emptyProject("型");
  const prefab = (id: string, name: string) => ({
    id,
    name,
    root: `${id}_r`,
    systems: [],
    keep: [],
  });
  const root = (id: string, of?: string) => ({
    id: `${id}_r`,
    name: id,
    prefab: id,
    parent: null,
    order: 0,
    states: {},
    ...(of ? { instanceOf: { prefab: of } } : {}),
  });
  p.prefabs = [prefab("pf_koma", "Koma"), prefab("pf_aka", "Aka")];
  p.prefabEntities = [root("pf_koma"), root("pf_aka", "pf_koma")];
  p.kokostates = [
    {
      id: "ks_k",
      name: "K",
      fields: types.map((type, i) => ({ id: `f${i}`, name: `v${i}`, type, default: undefined })),
      prefabImports: imports,
    },
  ];
  return p;
}
const run = (snapshot: ProjectSnapshot) =>
  checker.checkAll({ snapshot, packages: new Map(), hostDeclarations: host });
const schemaOf = (type: string): ValueSchema | undefined => run(project([type])).schemas.ks_k?.f0;
const errorsOf = (snapshot: ProjectSnapshot) =>
  run(snapshot)
    .diagnostics.filter((d) => d.subject.id === "ks_k")
    .map((d) => d.message);

const undef: ValueSchema = { kind: "undefined" };

describe("フィールドの型に書くプレハブ型・インスタンス型", () => {
  it("プレハブ型：スキーマは、そのプレハブの ID を持つプレハブの参照", () => {
    expect(schemaOf("Koma")).toEqual({ kind: "ref", target: "prefab", prefab: "pf_koma" });
    expect(schemaOf("Koma | undefined")).toEqual({
      kind: "union",
      options: [{ kind: "ref", target: "prefab", prefab: "pf_koma" }, undef],
    });
  });

  it("バリアントのプレハブ型は、バリアント自身の ID になる（印の先頭が自分）", () => {
    expect(schemaOf("Aka")).toEqual({ kind: "ref", target: "prefab", prefab: "pf_aka" });
  });

  it("インスタンス型：ふつうの Entity の参照と取り違えず、プレハブの ID を持つ", () => {
    expect(schemaOf("InstanceOf<Koma> | undefined")).toEqual({
      kind: "union",
      options: [{ kind: "ref", target: "entity", prefab: "pf_koma" }, undef],
    });
    expect(schemaOf("EntityRef | undefined")).toEqual({
      kind: "union",
      options: [{ kind: "ref", target: "entity" }, undef],
    });
  });

  it("リストやレコードの中にも書ける", () => {
    expect(schemaOf("Koma[]")).toEqual({
      kind: "list",
      item: { kind: "ref", target: "prefab", prefab: "pf_koma" },
    });
  });

  it("import していないプレハブの名前は、型エラーになる", () => {
    expect(errorsOf(project(["Koma"], []))).toHaveLength(1);
    expect(errorsOf(project(["Koma"]))).toEqual([]);
  });

  it("import の名前は変えられる（KokoState と重なるときに、別の名前を付ける）", () => {
    const p = project(["KomaPrefab"], [{ prefab: "pf_koma", name: "KomaPrefab" }]);
    expect(errorsOf(p)).toEqual([]);
    expect(run(p).schemas.ks_k?.f0).toEqual({ kind: "ref", target: "prefab", prefab: "pf_koma" });
  });

  it("スクリプトから読むと、フィールドの型はプレハブ型で、Prefab.spawn に渡せる", () => {
    const p = project(["Koma | undefined", "InstanceOf<Koma> | undefined"]);
    p.systems = [
      {
        id: "sys_a",
        name: "A",
        code: [
          'import K from "/K.koko";',
          "export default system({",
          "  query: { with: [K] },",
          "  onUpdate(e) {",
          "    const k = e.get(K);",
          "    if (k.v0) k.v1 = Prefab.spawn(k.v0);",
          "    if (k.v1) Prefab.destroy(k.v1);",
          "  },",
          "});",
        ].join("\n"),
      },
    ];
    expect(run(p).diagnostics.map((d) => d.message)).toEqual([]);
    // ふつうの Entity の参照は、インスタンス型のフィールドに入れられない
    const bad = project(["InstanceOf<Koma> | undefined"]);
    bad.systems = [
      {
        id: "sys_a",
        name: "A",
        code: 'import K from "/K.koko";\nexport default system({ query: { with: [K] }, onUpdate(e) { e.get(K).v0 = e.id; } });',
      },
    ];
    expect(run(bad).diagnostics).toHaveLength(1);
  });
});
