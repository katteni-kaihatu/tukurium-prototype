import type { FieldSchemas } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import { BUILTIN } from "./builtins";
import { checkProjectStructure } from "./diagnostics/structure";
import { collectSelection, extractInto } from "./extract";
import { packageResourceId } from "./packageDependency";
import { expandPrefabs } from "./prefab";
import { ProjectDoc } from "./projectDoc";
import { ResourcePathIndex } from "./resourcePath";
import type { PackageDependency, ProjectSnapshot } from "./schema";
import { compileSystem } from "./systemCompiler";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("テストの値がありません");
  return value;
}

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
          { id: "f_mat", name: "mat", type: "MaterialRef | undefined", default: undefined },
          { id: "f_tex", name: "tex", type: "TextureRef | undefined", default: undefined },
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

function prefabSource(): ProjectSnapshot {
  const s = source();
  s.kokostates.push({
    id: "ks_link",
    name: "Link",
    fields: [
      { id: "target", name: "target", type: "EntityRef | undefined", default: undefined },
      { id: "material", name: "material", type: "MaterialRef | undefined", default: undefined },
    ],
  });
  s.materials = [
    { id: "mat", name: "赤", color: "#f00", roughness: 1, metalness: 0, map: "image" },
  ];
  s.assets = [{ id: "image", name: "模様", kind: "image", contentType: "image/png" }];
  s.prefabs = [
    {
      id: "pf_outer",
      name: "外",
      root: "root",
      systems: [{ id: "sys_shoot", enabled: true }],
      keep: [],
    },
    {
      id: "pf_inner",
      name: "内",
      root: "inner_root",
      systems: [{ id: packageResourceId(combat, "sys_external"), enabled: false }],
      keep: [{ entity: "leaf", koko: "ks_link", field: "target" }],
    },
  ];
  s.prefabEntities = [
    {
      id: "root",
      name: "外",
      prefab: "pf_outer",
      parent: null,
      order: 0,
      states: { ks_link: { target: "nested/leaf", material: "mat" } },
    },
    {
      id: "nested",
      name: "内",
      prefab: "pf_outer",
      parent: "root",
      order: 0,
      states: {},
      instanceOf: { prefab: "pf_inner" },
    },
    {
      id: "inner_root",
      name: "内",
      prefab: "pf_inner",
      parent: null,
      order: 0,
      states: { [HEALTH]: {} },
    },
    {
      id: "leaf",
      name: "葉",
      prefab: "pf_inner",
      parent: "inner_root",
      order: 0,
      states: { ks_link: { target: "inner_root" } },
    },
  ];
  s.entities = [
    {
      id: "instance",
      name: "配置",
      output: "out",
      parent: null,
      order: 0,
      states: {},
      instanceOf: { prefab: "pf_outer" },
    },
    {
      id: "watcher",
      name: "参照元",
      output: "out",
      parent: "instance/nested/leaf",
      order: 1,
      states: { ks_link: { target: "instance/nested/leaf" } },
    },
  ];
  required(s.outputs[0]).systems = [];
  required(s.outputs[0]).keep = [
    { entity: "instance/nested/leaf", koko: "ks_link", field: "target" },
  ];
  s.placement = { ...s.placement, pf_outer: "f_combat" };
  return s;
}

describe("プレハブを抽出する", () => {
  it("アウトプットが使う入れ子と System・素材・依存を持っていく", () => {
    const s = prefabSource();
    const selected = collectSelection(s, { ...none, outputs: ["out"] });
    expect(selected.prefabs).toEqual(["pf_outer", "pf_inner"]);
    expect(selected.kokostates).toEqual(expect.arrayContaining(["ks_link", "ks_gun", HEALTH]));
    expect(selected.materials).toEqual(["mat"]);
    expect(selected.assets).toEqual(["image"]);
    const out = extractInto(s, { ...none, outputs: ["out"] }, src, null);
    expect(out.prefabs).toEqual(s.prefabs);
    expect(out.prefabEntities).toEqual(s.prefabEntities);
    expect(out.dependencies).toEqual([combat]);
    expect(ResourcePathIndex.fromSnapshot(out).pathOf("pf_outer")).toBe("/Combat/外.prefab");
    expect(
      expandPrefabs(out).entities.find((e) => e.id === "instance")?.states.ks_link?.target,
    ).toBe("instance/nested/leaf");
  });

  it("ID が重なると、入れ子の ID・内部と外からの参照・親・維持を一緒に付け替える", () => {
    const s = prefabSource();
    const dst = structuredClone(s);
    dst.name = "先";
    required(dst.kokostates.find((k) => k.id === "ks_link")).name = "別の型";
    required(dst.materials[0]).color = "#000";
    required(dst.assets?.[0]).name = "別の模様";
    required(dst.prefabs?.[1]).name = "別の内";
    const out = extractInto(s, { ...none, outputs: ["out"] }, src, dst);
    const outer = required(out.prefabs?.find((p) => p.name === "外_2"));
    const inner = required(out.prefabs?.find((p) => p.name === "内"));
    const leaf = required(
      out.prefabEntities?.find((e) => e.prefab === inner.id && e.name === "葉"),
    );
    const nested = required(
      out.prefabEntities?.find((e) => e.prefab === outer.id && e.name === "内"),
    );
    const root = required(out.prefabEntities?.find((e) => e.id === outer.root));
    const instance = required(out.entities.find((e) => e.instanceOf?.prefab === outer.id));
    const watcher = required(
      out.entities.find((e) => e.output === instance.output && e.name === "参照元"),
    );
    const koko = required(out.kokostates.find((k) => k.name.startsWith("Link")));
    const targetId = `${instance.id}/${nested.id}/${leaf.id}`;
    expect(nested.instanceOf?.prefab).toBe(inner.id);
    expect(nested.parent).toBe(root.id);
    expect(root.states[koko.id]?.target).toBe(`${nested.id}/${leaf.id}`);
    expect(watcher.states[koko.id]?.target).toBe(targetId);
    expect(watcher.parent).toBe(targetId);
    expect(out.outputs.find((o) => o.id === instance.output)?.keep[0]).toEqual({
      entity: targetId,
      koko: koko.id,
      field: "target",
    });
    expect(inner.keep[0]).toEqual({ entity: leaf.id, koko: koko.id, field: "target" });
    const material = required(out.materials.find((m) => m.id === root.states[koko.id]?.material));
    expect(material.map).not.toBe("image");
    expect(
      expandPrefabs(out).entities.find((e) => e.id === instance.id)?.states[koko.id]?.target,
    ).toBe(targetId);
  });

  it("プレハブだけを選べる。同じ中身があれば再利用し、由来にパスを残す", () => {
    const s = prefabSource();
    const extracted = extractInto(s, { ...none, prefabs: ["pf_outer"] }, src, null);
    expect(extracted.outputs).toEqual([]);
    expect(extracted.entities).toEqual([]);
    expect(extracted.prefabs).toHaveLength(2);
    expect(extracted.provenance?.[0]?.paths).toEqual(["/Combat/外.prefab"]);
    const again = extractInto(s, { ...none, prefabs: ["pf_outer"] }, src, extracted);
    expect(again.prefabs).toHaveLength(2);
    expect(again.prefabEntities).toHaveLength(4);
  });

  it("既存と同じ A は再利用し、新規の B だけを足す", () => {
    const project = new ProjectDoc();
    const a = project.addPrefab("A");
    const destination = project.snapshot();
    const b = project.addPrefab("B");
    const out = extractInto(project.snapshot(), { ...none, prefabs: [a, b] }, src, destination);
    expect(out.prefabs?.map((p) => p.id)).toEqual([a, b]);
    expect(out.prefabEntities).toHaveLength(2);
    expect(checkProjectStructure(out)).toEqual([]);
  });

  it("別のプレハブが使う素材の ID が変わっても、無関係なプレハブは再利用する", () => {
    const project = new ProjectDoc();
    const a = project.addPrefab("A");
    const b = project.addPrefab("B");
    const material = project.addMaterial("材質");
    project.addState(required(project.prefab(b)).root, BUILTIN.Mesh, { material });
    const source = project.snapshot();
    const destination = project.snapshot();
    required(destination.materials[0]).color = "#000000";
    const out = extractInto(source, { ...none, prefabs: [a, b] }, src, destination);
    expect(out.prefabs?.filter((p) => p.id === a)).toHaveLength(1);
    expect(out.prefabs?.filter((p) => p.name === "A")).toHaveLength(1);
    const copy = required(out.prefabs?.find((p) => p.name === "B_2"));
    const root = required(out.prefabEntities?.find((e) => e.id === copy.root));
    expect(root.states[BUILTIN.Mesh]?.material).not.toBe(material);
    expect(out.prefabs).toHaveLength(3);
    expect(
      checkProjectStructure(out).filter(
        (d) => d.code === "name-collision" && d.subject.kind === "prefab",
      ),
    ).toEqual([]);
  });

  it("入れ子の ID が変わる場合は親も写し、複製したプレハブの名前を分ける", () => {
    const project = new ProjectDoc();
    const a = project.addPrefab("A");
    const b = project.addPrefab("B");
    project.addPrefabEntity({ prefab: a, name: "入れ子", instanceOf: { prefab: b } });
    const destination = project.snapshot();
    project.setField(required(project.prefab(b)).root, BUILTIN.Transform, "position", [1, 0, 0]);
    const out = extractInto(project.snapshot(), { ...none, prefabs: [a] }, src, destination);
    const copiedA = required(out.prefabs?.find((p) => p.name === "A_2"));
    const copiedB = required(out.prefabs?.find((p) => p.name === "B_2"));
    const nested = required(
      out.prefabEntities?.find((e) => e.prefab === copiedA.id && e.instanceOf),
    );
    expect(nested.instanceOf?.prefab).toBe(copiedB.id);
    expect(out.prefabs).toHaveLength(4);
    expect(checkProjectStructure(out)).toEqual([]);
  });

  it("ライブラリが含めたプレハブと、ライブラリのプレハブを指す lock も持っていく", () => {
    const s = prefabSource();
    s.outputs = [
      { id: "lib", name: "部品", kind: "library", systems: [], keep: [], resources: ["pf_outer"] },
    ];
    s.entities = [];
    expect(extractInto(s, { ...none, outputs: ["lib"] }, src, null).prefabs).toHaveLength(2);
    s.outputs = [{ id: "out", name: "配置", kind: "item", systems: [], keep: [] }];
    s.entities = [
      {
        id: "package_instance",
        name: "部品",
        output: "out",
        parent: null,
        order: 0,
        states: {},
        instanceOf: { prefab: packageResourceId(combat, "pf_external") },
      },
    ];
    expect(extractInto(s, { ...none, outputs: ["out"] }, src, null).dependencies).toEqual([combat]);
  });

  it("上書きの道と参照・足した KokoState・解除後の System・消えた親も付け替える", () => {
    const s = prefabSource();
    s.kokostates.push({
      id: "ks_extra",
      name: "Extra",
      fields: [{ id: "target", name: "target", type: "EntityRef | undefined", default: undefined }],
    });
    s.systems.push(
      { id: "sys_instance", name: "Instance", code: "" },
      { id: "sys_unpacked", name: "Unpacked", code: "" },
    );
    const instance = required(s.entities.find((e) => e.id === "instance"));
    instance.prefabOverrides = {
      "nested/leaf": {
        parent: "instance",
        states: { ks_link: { target: "instance/nested/leaf", material: "mat" } },
        addedStates: { ks_extra: { target: "watcher" } },
      },
    };
    instance.instanceSystems = [{ id: "sys_instance", enabled: true }];
    instance.unpackedSystems = [{ id: "sys_unpacked", enabled: false }];
    const nested = required(s.prefabEntities?.find((e) => e.id === "nested"));
    nested.prefabOverrides = { leaf: { parent: "root", states: { ks_link: { target: "root" } } } };
    required(s.prefabs?.find((p) => p.id === "pf_inner")).deletedParents = { gone: "inner_root" };
    const destination = structuredClone(s);
    for (const system of destination.systems) system.code = "// 取り込み先のコード";
    required(destination.kokostates.find((k) => k.id === "ks_link")).name = "別のLink";
    required(destination.kokostates.find((k) => k.id === "ks_extra")).name = "別のExtra";
    const selected = collectSelection(s, { ...none, outputs: ["out"] });
    expect(selected.systems).toEqual(expect.arrayContaining(["sys_instance", "sys_unpacked"]));
    expect(selected.kokostates).toContain("ks_extra");
    const out = extractInto(s, { ...none, outputs: ["out"] }, src, destination);
    const copied = required(out.entities.find((e) => e.id !== "instance" && e.name === "配置"));
    const outer = required(out.prefabs?.find((p) => p.id === copied.instanceOf?.prefab));
    const innerEntity = required(
      out.prefabEntities?.find((e) => e.prefab === outer.id && e.name === "内"),
    );
    const inner = required(out.prefabs?.find((p) => p.id === innerEntity.instanceOf?.prefab));
    const leaf = required(
      out.prefabEntities?.find((e) => e.prefab === inner.id && e.name === "葉"),
    );
    const link = required(out.kokostates.find((k) => k.name === "Link"));
    const extra = required(out.kokostates.find((k) => k.name === "Extra"));
    const watcher = required(
      out.entities.find((e) => e.output === copied.output && e.name === "参照元"),
    );
    expect(copied.prefabOverrides?.[`${innerEntity.id}/${leaf.id}`]).toEqual({
      parent: copied.id,
      states: {
        [link.id]: { target: `${copied.id}/${innerEntity.id}/${leaf.id}`, material: "mat" },
      },
      addedStates: { [extra.id]: { target: watcher.id } },
    });
    expect(innerEntity.prefabOverrides?.[leaf.id]).toEqual({
      parent: outer.root,
      states: { [link.id]: { target: outer.root } },
    });
    expect(inner.deletedParents).toEqual({ gone: inner.root });
    expect(copied.instanceSystems).toEqual([
      {
        id: required(
          out.systems.find((sys) => sys.name === "Instance" && sys.id !== "sys_instance"),
        ).id,
        enabled: true,
      },
    ]);
    expect(copied.unpackedSystems).toEqual([
      {
        id: required(
          out.systems.find((sys) => sys.name === "Unpacked" && sys.id !== "sys_unpacked"),
        ).id,
        enabled: false,
      },
    ]);
  });

  it("ライブラリの KokoState も、渡されたスキーマで入れ子の参照を収集し付け替える", () => {
    const s = prefabSource();
    const root = required(s.prefabEntities?.find((e) => e.id === "inner_root"));
    root.states[HEALTH] = { materials: ["library_mat"] };
    s.materials.push({
      id: "library_mat",
      name: "依存の材質",
      color: "#f00",
      roughness: 1,
      metalness: 0,
    });
    const schemas: FieldSchemas = {
      [HEALTH]: { materials: { kind: "list", item: { kind: "ref", target: "material" } } },
    };
    const destination = target();
    destination.materials = [
      { id: "library_mat", name: "別の材質", color: "#000", roughness: 1, metalness: 0 },
    ];
    const out = extractInto(
      s,
      { ...none, prefabs: ["pf_inner"] },
      src,
      destination,
      undefined,
      schemas,
    );
    const material = required(out.materials.find((m) => m.name === "依存の材質"));
    expect(material.id).not.toBe("library_mat");
    expect(out.prefabEntities?.find((e) => e.id === root.id)?.states[HEALTH]?.materials).toEqual([
      material.id,
    ]);
    expect(out.dependencies).toEqual([combat]);
  });
});
