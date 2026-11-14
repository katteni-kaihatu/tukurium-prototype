import type { FieldSchemas } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import { BUILTIN } from "./builtins";
import {
  changedRefs,
  dirtyRefs,
  type GraphRef,
  ProjectDependencyGraph,
  refKey,
  usersOf,
} from "./dependencyGraph";
import type { ProjectSnapshot } from "./schema";

function base(): ProjectSnapshot {
  return {
    version: 1,
    name: "p",
    kokostates: [
      { id: "ks_gun", name: "Gun", fields: [] },
      { id: "ks_hp", name: "Health", fields: [] },
    ],
    systems: [
      {
        id: "sys_shoot",
        name: "Shoot",
        code: 'import Gun from "./Gun.koko";\nexport default { query: { with: [Gun] } }',
      },
      {
        id: "sys_hp",
        name: "Hp",
        code: 'import Health from "./Health.koko";\nimport Shield from "./Shield.koko";\nexport default { query: { with: [Health, Shield] } }',
      },
    ],
    materials: [{ id: "m", name: "Wood", color: "#fff", roughness: 1, metalness: 0, map: "img" }],
    assets: [{ id: "img", name: "Bark", kind: "image", contentType: "image/png" }],
    outputs: [
      {
        id: "out",
        name: "射撃場",
        kind: "item",
        systems: [{ id: "sys_shoot", enabled: true }],
        keep: [],
      },
    ],
    entities: [
      {
        id: "e",
        name: "銃",
        parent: null,
        output: "out",
        order: 0,
        states: { [BUILTIN.Mesh]: { material: "m", model: undefined }, ks_gun: {} },
      },
      { id: "c", name: "弾", parent: "e", output: "out", order: 0, states: {} },
    ],
    folders: [],
    placement: {},
  };
}

const keys = (refs: Iterable<GraphRef>) => [...refs].map(refKey).sort();

describe("ProjectDependencyGraph", () => {
  const g = ProjectDependencyGraph.fromSnapshot(base());

  it("Material → 画像、Entity → Material・KokoState・親、Output → System・Entity", () => {
    expect(keys(g.dependenciesOf({ kind: "material", id: "m" }))).toEqual(["asset:img"]);
    expect(keys(g.dependenciesOf({ kind: "entity", id: "e" }))).toEqual([
      "kokostate:builtin.Mesh",
      "kokostate:ks_gun",
      "material:m",
    ]);
    expect(keys(g.dependenciesOf({ kind: "entity", id: "c" }))).toEqual(["entity:e"]);
    expect(keys(g.dependenciesOf({ kind: "output", id: "out" }))).toEqual([
      "entity:c",
      "entity:e",
      "system:sys_shoot",
    ]);
  });

  it("System → import した KokoState とパスの構造（見つからない import はパスの構造だけ）", () => {
    expect(keys(g.dependenciesOf({ kind: "system", id: "sys_shoot" }))).toEqual([
      "kokostate:ks_gun",
      "name:paths",
    ]);
    expect(keys(g.dependenciesOf({ kind: "system", id: "sys_hp" }))).toEqual([
      "kokostate:ks_hp",
      "name:paths",
    ]);
  });

  it("依存元を逆にたどる", () => {
    expect(keys(g.dependentsOf({ kind: "asset", id: "img" }))).toEqual(["material:m"]);
    expect(keys(g.transitiveDependents([{ kind: "asset", id: "img" }]))).toEqual([
      "asset:img",
      "entity:c",
      "entity:e",
      "material:m",
      "output:out",
    ]);
  });

  it("インスタンスの上書き・追加した KokoState と System も保存元の依存にする", () => {
    const snap = base();
    snap.kokostates.push({
      id: "ks_links",
      name: "Links",
      fields: [{ id: "refs", name: "refs", type: "EntityRef[]", default: [] }],
    });
    const instance = snap.entities[0];
    if (!instance) throw new Error("Entity がありません");
    instance.instanceOf = { prefab: "prefab" };
    instance.prefabOverrides = {
      child: {
        states: { [BUILTIN.Mesh]: { material: "override_material" } },
        addedStates: { ks_links: { refs: ["other/child"] } },
        parent: "other/parent",
      },
    };
    instance.instanceSystems = [{ id: "instance_system", enabled: true }];
    const schemas: FieldSchemas = {
      ks_links: { refs: { kind: "list", item: { kind: "ref", target: "entity" } } },
    };
    const graph = ProjectDependencyGraph.fromSnapshot(snap, schemas);
    expect(keys(graph.dependenciesOf({ kind: "entity", id: "e" }))).toEqual(
      expect.arrayContaining([
        "entity:other",
        "kokostate:ks_links",
        "material:override_material",
        "prefab:prefab",
        "system:instance_system",
      ]),
    );
    expect(keys(graph.transitiveDependents([{ kind: "system", id: "instance_system" }]))).toContain(
      "output:out",
    );
    expect(keys(graph.dependenciesOf({ kind: "entity", id: "e/child" }))).toEqual([]);
  });

  it("プレハブの中のインスタンスの追加分は、そのプレハブの依存になる", () => {
    const snap = base();
    snap.prefabEntities = [
      {
        id: "nested",
        name: "中のインスタンス",
        prefab: "outer",
        parent: "root",
        order: 0,
        states: {},
        instanceOf: { prefab: "inner" },
        prefabOverrides: {
          child: { addedStates: { [BUILTIN.Mesh]: { material: "nested_material" } } },
        },
        instanceSystems: [{ id: "nested_system", enabled: false }],
      },
    ];
    const graph = ProjectDependencyGraph.fromSnapshot(snap);
    expect(keys(graph.dependenciesOf({ kind: "prefab", id: "outer" }))).toEqual([
      "kokostate:builtin.Mesh",
      "material:nested_material",
      "prefab:inner",
      "system:nested_system",
    ]);
  });
});

describe("usersOf", () => {
  const g = ProjectDependencyGraph.fromSnapshot(base());

  it("直接使っているものだけを返す（名前の節は含めない）", () => {
    expect(keys(usersOf(g, { kind: "asset", id: "img" }))).toEqual(["material:m"]);
    expect(keys(usersOf(g, { kind: "material", id: "m" }))).toEqual(["entity:e"]);
    expect(keys(usersOf(g, { kind: "system", id: "sys_shoot" }))).toEqual(["output:out"]);
  });

  it("KokoState は、持っている Entity と、import した System を合わせる", () => {
    expect(keys(usersOf(g, { kind: "kokostate", id: "ks_gun" }))).toEqual([
      "entity:e",
      "system:sys_shoot",
    ]);
    expect(keys(usersOf(g, { kind: "kokostate", id: "ks_hp" }))).toEqual(["system:sys_hp"]);
  });
});

describe("増分の無効化", () => {
  it("素材を消すと、関係する Material・Entity（とその子）・アウトプットだけが dirty になる", () => {
    const prev = base();
    const next = { ...base(), assets: [] };
    // 素材が消えるとパスの構造も変わる（import を書いた System は、解決先が変わりうるので調べ直す）
    expect(keys(changedRefs(prev, next))).toEqual(["asset:img", "name:paths"]);
    expect(keys(dirtyRefs(prev, next))).toEqual([
      "asset:img",
      "entity:c",
      "entity:e",
      "material:m",
      "name:paths",
      "output:out",
      "system:sys_hp",
      "system:sys_shoot",
    ]);
  });

  it("System のコードを変えると、その System だけ（関係のない System は調べ直さない）", () => {
    const prev = base();
    const next = base();
    next.systems = next.systems.map((s) =>
      s.id === "sys_shoot" ? { ...s, code: `${s.code}\n` } : s,
    );
    const dirty = keys(dirtyRefs(prev, next));
    expect(dirty).toContain("system:sys_shoot");
    expect(dirty).not.toContain("system:sys_hp");
    expect(dirty).toContain("output:out");
  });

  it("KokoState の名前を変えると、それを import した System が dirty になる", () => {
    const prev = base();
    const next = base();
    next.kokostates = next.kokostates.map((k) => (k.id === "ks_hp" ? { ...k, name: "Shield" } : k));
    expect(keys(dirtyRefs(prev, next))).toContain("system:sys_hp");
  });

  it("見つからなかった import の KokoState を作ると、それを書いた System が dirty になる", () => {
    const prev = base();
    const next = base();
    next.kokostates = [...next.kokostates, { id: "ks_sh", name: "Shield", fields: [] }];
    expect(keys(dirtyRefs(prev, next))).toContain("system:sys_hp");
  });

  it("マテリアルの色を変えても System は dirty にならない", () => {
    const prev = base();
    const next = base();
    next.materials = next.materials.map((m) => ({ ...m, color: "#000" }));
    const dirty = keys(dirtyRefs(prev, next));
    expect(dirty.filter((k) => k.startsWith("system:"))).toEqual([]);
  });
});

describe("import で書いた System の依存", () => {
  function withImport(): ProjectSnapshot {
    const s = base();
    s.folders = [{ id: "f", name: "States", parent: null }];
    s.placement = { ks_gun: "f" };
    s.systems = s.systems.map((x) =>
      x.id === "sys_shoot"
        ? {
            ...x,
            code: 'import Gun from "/States/Gun.koko";\nexport default system({ query: { with: [Gun] } });',
          }
        : // import を書かない System（パスの構造に依存しない）
          { ...x, code: "export default system({ query: { with: [] } });" },
    );
    return s;
  }

  it("結び付けた KokoState の ID と、パスの構造に依存する", () => {
    const g = ProjectDependencyGraph.fromSnapshot(withImport());
    expect(keys(g.dependenciesOf({ kind: "system", id: "sys_shoot" }))).toEqual([
      "kokostate:ks_gun",
      "name:paths",
    ]);
  });

  it("フォルダの名前を変えると、import を書いた System だけが dirty になる", () => {
    const prev = withImport();
    const next = withImport();
    next.folders = [{ id: "f", name: "Parts", parent: null }];
    const dirty = keys(dirtyRefs(prev, next));
    expect(dirty).toContain("system:sys_shoot");
    expect(dirty).not.toContain("system:sys_hp");
  });

  it("パスに関係しない変更（マテリアルの色）では dirty にならない", () => {
    const prev = withImport();
    const next = withImport();
    next.materials = next.materials.map((m) => ({ ...m, color: "#000" }));
    expect(keys(dirtyRefs(prev, next)).filter((k) => k.startsWith("system:"))).toEqual([]);
  });
});
