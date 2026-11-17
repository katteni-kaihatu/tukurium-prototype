import { gunAndTargetSample, type ProjectSnapshot, ResourcePathIndex } from "@tukurium/repo-model";
import { hostApiDeclarations } from "@tukurium/runtime";
import { describe, expect, it } from "vitest";
import { TypeChecker } from "./checker";
import { nodeTypeCheckerOptions } from "./node";

/**
 * System から、プレハブ・マテリアルを値として import する（ADR 0082）。プレハブの宣言ファイルが、
 * プレハブ型（印とパラメータ）になっていることを、型エラーの出方で確かめる。
 */
const checker = new TypeChecker(nodeTypeCheckerOptions());
const host = hostApiDeclarations();

/** 銃と的のサンプルに、Bullet（Hp は必須・Max は省略できる）と、そのバリアント Red、別のプレハブ Other を足す */
function project(body: string): { snap: ProjectSnapshot; material: string } {
  const snap = gunAndTargetSample();
  const target = snap.kokostates.find((k) => k.name === "Target");
  const hp = target?.fields.find((f) => f.name === "hp");
  const respawn = target?.fields.find((f) => f.name === "maxHp");
  if (!target || !hp || !respawn) throw new Error("Target がありません");
  const params = {
    a: { name: "Hp", entity: "", koko: target.id, field: hp.id, required: true, order: 0 },
    b: {
      name: "Max",
      entity: "",
      koko: target.id,
      field: respawn.id,
      required: false,
      description: "いちばん多いときの hp",
      order: 1,
    },
  };
  const prefab = (id: string, name: string, own?: typeof params) => ({
    id,
    name,
    root: `${id}_root`,
    systems: [],
    keep: [],
    ...(own ? { params: own } : {}),
  });
  const root = (id: string, of?: string) => ({
    id: `${id}_root`,
    name: id,
    prefab: id,
    parent: null,
    order: 0,
    states: { [target.id]: {} },
    ...(of ? { instanceOf: { prefab: of } } : {}),
  });
  snap.prefabs = [
    prefab("pf_bullet", "Bullet", params),
    prefab("pf_red", "Red"),
    prefab("pf_other", "Other", params),
  ];
  snap.prefabEntities = [root("pf_bullet"), root("pf_red", "pf_bullet"), root("pf_other")];
  const index = ResourcePathIndex.fromSnapshot(snap);
  const material = snap.materials[0];
  if (!material) throw new Error("マテリアルがありません");
  const path = (id: string) => index.pathOf(id)?.replace(/\.[a-z]+$/, (ext) => ext) ?? "";
  snap.systems.push({
    id: "sys_t",
    name: "T",
    code: [
      `import Bullet from ${JSON.stringify(path("pf_bullet"))};`,
      `import Red from ${JSON.stringify(path("pf_red"))};`,
      `import Other from ${JSON.stringify(path("pf_other"))};`,
      `import Mat from ${JSON.stringify(path(material.id))};`,
      `import Target from ${JSON.stringify(path(target.id))};`,
      "export default system({",
      "  query: { with: [Target] },",
      `  onUpdate(e) {\n${body}\n  },`,
      "});",
    ].join("\n"),
  });
  return { snap, material: material.id };
}
const errors = (body: string) =>
  checker
    .check({
      snapshot: project(body).snap,
      packages: new Map(),
      hostDeclarations: host,
      systemIds: ["sys_t"],
    })
    .map((d) => d.message);

describe("System からプレハブ・マテリアルを import する", () => {
  it("import した値に型が付き、型エラーにならない", () => {
    expect(
      errors(
        [
          "const b: typeof Bullet = Bullet;",
          "const m: MaterialRef = Mat;",
          "const id: string = Bullet;",
          "void b; void m; void id;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("パラメータの型は、指すフィールドの型。必須と省略できるものが分かれる", () => {
    expect(
      errors(
        [
          "const a: PrefabParamsOf<typeof Bullet> = { Hp: 3 };",
          "const b: PrefabParamsOf<typeof Bullet> = { Hp: 3, Max: 1 };",
          "void a; void b;",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(errors("const a: PrefabParamsOf<typeof Bullet> = { Max: 1 }; void a;")).toHaveLength(1);
    expect(errors('const a: PrefabParamsOf<typeof Bullet> = { Hp: "多い" }; void a;')).toHaveLength(
      1,
    );
    expect(
      errors("const a: PrefabParamsOf<typeof Bullet> = { Hp: 3, Nai: 1 }; void a;"),
    ).toHaveLength(1);
  });

  it("バリアントは、元のプレハブ型に当てはまり、パラメータを受け継ぐ。別のプレハブは当てはまらない", () => {
    expect(
      errors(
        [
          "const a: typeof Bullet = Red;",
          "const p: PrefabParamsOf<typeof Red> = { Hp: 3 };",
          "void a; void p;",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(errors("const a: typeof Bullet = Other; void a;")).toHaveLength(1);
    expect(errors("const a: typeof Red = Bullet; void a;")).toHaveLength(1);
  });

  it("インスタンス型：バリアントのインスタンスは元のインスタンス型に当てはまり、ふつうの Entity の参照は当てはまらない", () => {
    expect(
      errors(
        [
          "const red = undefined as unknown as InstanceOf<typeof Red>;",
          "const a: InstanceOf<typeof Bullet> = red;",
          "const ref: EntityRef = red;",
          "void a; void ref;",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(errors("const a: InstanceOf<typeof Bullet> = e.id; void a;")).toHaveLength(1);
  });

  it("コードホバーにパラメータの説明が出て、定義へ移動でプレハブを指す", () => {
    const { snap } = project("const p: PrefabParamsOf<typeof Bullet> = { Hp: 3, Max: 1 }; void p;");
    const code = snap.systems.find((s) => s.id === "sys_t")?.code ?? "";
    checker.prepare({ snapshot: snap, packages: new Map(), hostDeclarations: host });
    const at = { fileId: "sys_t", code };
    const hover = checker.query({ ...at, kind: "hover", position: code.indexOf("Max: 1") + 1 });
    expect(hover?.documentation).toContain("いちばん多いときの hp");
    const def = checker.query({
      ...at,
      kind: "definition",
      position: code.indexOf("typeof Bullet") + "typeof ".length + 1,
    });
    expect(def).toMatchObject({ kind: "prefab", id: "pf_bullet" });
  });
});
