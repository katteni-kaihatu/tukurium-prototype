import { describe, expect, it } from "vitest";
import { collectSelection, extractInto } from "./extract";
import { packageResourceId } from "./packageDependency";
import { ResourcePathIndex } from "./resourcePath";
import type { PackageDependency, ProjectSnapshot } from "./schema";
import { compileSystem } from "./systemCompiler";

const src = { repoId: "r_src", repoName: "元", commit: "c1" };
const combat: PackageDependency = {
  alias: "combat",
  packageId: "w_lib",
  version: 3,
  contentHash: "h3",
};
const HEALTH = packageResourceId(combat, "ks_health");
const none = { outputs: [], kokostates: [], systems: [], materials: [], assets: [] };

/** Combat/States/Gun.koko と、それを相対パスで import する Combat/Systems/Shoot。ライブラリ @combat も使う */
function source(): ProjectSnapshot {
  return {
    version: 1,
    name: "元",
    kokostates: [{ id: "ks_gun", name: "Gun", fields: [] }],
    systems: [
      {
        id: "sys_shoot",
        name: "Shoot",
        code: `import Gun from "../States/Gun.koko";\nimport Health from "@combat/States/Health.koko";\nexport default system({ query: { with: [Gun, Health] } });\n`,
      },
    ],
    materials: [],
    outputs: [
      {
        id: "out",
        name: "銃",
        kind: "item",
        systems: [{ id: "sys_shoot", enabled: true }],
        keep: [],
      },
    ],
    entities: [
      {
        id: "ent",
        name: "銃",
        parent: null,
        output: "out",
        order: 0,
        states: { ks_gun: {}, [HEALTH]: {} },
      },
    ],
    folders: [
      { id: "f_combat", name: "Combat", parent: null },
      { id: "f_states", name: "States", parent: "f_combat" },
      { id: "f_sys", name: "Systems", parent: "f_combat" },
    ],
    placement: { ks_gun: "f_states", sys_shoot: "f_sys" },
    dependencies: [combat],
  };
}

const target = (deps: PackageDependency[] = []): ProjectSnapshot => ({
  version: 1,
  name: "先",
  kokostates: [],
  systems: [],
  materials: [],
  outputs: [],
  entities: [],
  dependencies: deps,
});

/** 取り込み先で、System の import が解決できるか（依存の中身は渡さないので @ は数えない） */
const unresolved = (snap: ProjectSnapshot, systemId: string) => {
  const s = snap.systems.find((x) => x.id === systemId);
  return compileSystem(systemId, s?.code ?? "", ResourcePathIndex.fromSnapshot(snap))
    .diagnostics.map((d) => d.code)
    .filter((c) => c !== "import-package-unavailable");
};

describe("抽出で出所と結び付けを保つ（ADR 0015）", () => {
  it("取り出したものが入っていたフォルダも作り、相対パスの import がそのまま解決できる", () => {
    const out = extractInto(source(), { ...none, outputs: ["out"] }, src, null, "新");
    expect(out.folders?.map((f) => f.name).sort()).toEqual(["Combat", "States", "Systems"]);
    const index = ResourcePathIndex.fromSnapshot(out);
    expect(index.pathOf("ks_gun")).toBe("/Combat/States/Gun.koko");
    expect(unresolved(out, "sys_shoot")).toEqual([]);
  });

  it("同じパスのフォルダがあれば使う。名前を付け替えた KokoState へ import を書き直す", () => {
    const dst = target();
    dst.folders = [{ id: "f_mine", name: "Combat", parent: null }];
    dst.kokostates = [{ id: "ks_other", name: "Gun", fields: [] }];
    const out = extractInto(source(), { ...none, outputs: ["out"] }, src, dst);
    expect(out.folders?.filter((f) => f.name === "Combat")).toHaveLength(1);
    const shoot = out.systems.find((s) => s.id === "sys_shoot");
    expect(shoot?.code).toContain(`import Gun from "../States/Gun_2.koko";`);
    expect(unresolved(out, "sys_shoot")).toEqual([]);
  });

  it("使っているライブラリを依存として持ってきて、由来に残す", () => {
    const out = extractInto(source(), { ...none, outputs: ["out"] }, src, target());
    expect(out.dependencies).toEqual([combat]);
    expect(out.entities[0]?.states[HEALTH]).toEqual({});
    expect(out.provenance?.[0]?.dependencies).toEqual([combat]);
  });

  it("System だけを取り出しても、その System が import するライブラリを持ってくる", () => {
    const out = extractInto(source(), { ...none, systems: ["sys_shoot"] }, src, target());
    expect(out.dependencies?.map((d) => d.alias)).toEqual(["combat"]);
  });

  it("取り込み先に同じ lock があれば、その別名を使って import を書き直す", () => {
    const out = extractInto(
      source(),
      { ...none, outputs: ["out"] },
      src,
      target([{ ...combat, alias: "c" }]),
    );
    expect(out.dependencies?.map((d) => d.alias)).toEqual(["c"]);
    expect(out.systems[0]?.code).toContain(`"@c/States/Health.koko"`);
    expect(out.provenance?.[0]?.dependencies).toBeUndefined();
  });

  it("別名がほかのライブラリとぶつかれば付け替える。同じライブラリの別の版は共存させる", () => {
    const other = { alias: "combat", packageId: "w_other", version: 1, contentHash: "x" };
    const a = extractInto(source(), { ...none, outputs: ["out"] }, src, target([other]));
    expect(a.dependencies?.map((d) => [d.alias, d.packageId])).toEqual([
      ["combat", "w_other"],
      ["combat_2", "w_lib"],
    ]);
    expect(a.systems[0]?.code).toContain(`"@combat_2/States/Health.koko"`);

    const v4 = { ...combat, version: 4, contentHash: "h4" };
    const b = extractInto(source(), { ...none, outputs: ["out"] }, src, target([v4]));
    expect(b.dependencies?.map((d) => [d.alias, d.version])).toEqual([
      ["combat", 4],
      ["combat_2", 3],
    ]);
    // Entity の KokoState は v3 のまま（v3 の依存も持ってきたので、注意にならない）
    expect(b.entities[0]?.states[HEALTH]).toEqual({});
  });
});

describe("ライブラリのアウトプットを取り込む（ADR 0055）", () => {
  it("含めたリソースを一緒に持ってきて、付け替えた ID で含め直す", () => {
    const s = source();
    s.entities = [];
    s.outputs = [
      {
        id: "lib",
        name: "銃の部品",
        kind: "library",
        systems: [],
        keep: [],
        resources: ["sys_shoot"],
      },
    ];
    const dst = target();
    dst.kokostates = [{ id: "ks_gun", name: "Other", fields: [] }];
    const out = extractInto(s, { ...none, outputs: ["lib"] }, src, dst);
    expect(out.systems.map((x) => x.id)).toEqual(["sys_shoot"]);
    // Shoot が import する Gun も来る（ID がぶつかったので付け替わる）
    const gun = out.kokostates.find((k) => k.name === "Gun");
    expect(gun?.id).not.toBe("ks_gun");
    expect(out.outputs.find((o) => o.kind === "library")?.resources).toEqual(["sys_shoot"]);
  });
});

describe("取り出すものを依存グラフで集める", () => {
  const snap: ProjectSnapshot = {
    version: 1,
    name: "元",
    kokostates: [
      {
        id: "ks_skin",
        name: "Skin",
        fields: [
          { id: "f_mat", name: "mat", type: "material", default: undefined },
          { id: "f_tex", name: "tex", type: "texture", default: undefined },
        ],
      },
    ],
    systems: [],
    materials: [
      { id: "m_red", name: "Red", color: "#f00", roughness: 1, metalness: 0, map: "img_a" },
      { id: "m_unused", name: "Unused", color: "#000", roughness: 1, metalness: 0 },
    ],
    assets: [
      { id: "img_a", name: "A", kind: "image", contentType: "image/png" },
      { id: "img_b", name: "B", kind: "image", contentType: "image/png" },
    ],
    outputs: [{ id: "out", name: "箱", kind: "item", systems: [], keep: [] }],
    entities: [
      {
        id: "e",
        name: "箱",
        parent: null,
        output: "out",
        order: 0,
        states: { ks_skin: { f_mat: "m_red", f_tex: "img_b" } },
      },
    ],
  };

  it("自作の KokoState の欄で指したマテリアルと画像、マテリアルの画像も持ってくる", () => {
    const sel = collectSelection(snap, { ...none, outputs: ["out"] });
    expect(sel.kokostates).toEqual(["ks_skin"]);
    expect(sel.materials).toEqual(["m_red"]);
    expect([...sel.assets].sort()).toEqual(["img_a", "img_b"]);
  });
});
