import { describe, expect, it } from "vitest";
import { BUILTIN } from "./builtins";
import {
  changedRefs,
  dirtyRefs,
  type GraphRef,
  ProjectDependencyGraph,
  refKey,
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
      { id: "sys_shoot", name: "Shoot", code: 'export default { query: { with: ["Gun"] } }' },
      {
        id: "sys_hp",
        name: "Hp",
        code: 'export default { query: { with: ["Health", "Shield"] } }',
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
        states: { [BUILTIN.Mesh]: { material: "m", model: null }, ks_gun: {} },
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

  it("System → Query の KokoState（見つからない名前は名前の節で持つ）", () => {
    expect(keys(g.dependenciesOf({ kind: "system", id: "sys_shoot" }))).toEqual([
      "name:kokostate/Gun",
    ]);
    expect(keys(g.dependenciesOf({ kind: "system", id: "sys_hp" }))).toEqual([
      "name:kokostate/Health",
      "name:kokostate/Shield",
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
});

describe("増分の無効化", () => {
  it("素材を消すと、関係する Material・Entity（とその子）・アウトプットだけが dirty になる", () => {
    const prev = base();
    const next = { ...base(), assets: [] };
    expect(keys(changedRefs(prev, next))).toEqual(["asset:img"]);
    expect(keys(dirtyRefs(prev, next))).toEqual([
      "asset:img",
      "entity:c",
      "entity:e",
      "material:m",
      "output:out",
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

  it("KokoState の名前を変えると、古い名前・新しい名前を Query に書いた System が dirty になる", () => {
    const prev = base();
    const next = base();
    next.kokostates = next.kokostates.map((k) => (k.id === "ks_hp" ? { ...k, name: "Shield" } : k));
    const dirty = keys(dirtyRefs(prev, next));
    expect(dirty).toContain("system:sys_hp");
    expect(dirty).not.toContain("system:sys_shoot");
  });

  it("見つからなかった名前の KokoState を作ると、それを書いた System が dirty になる", () => {
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
