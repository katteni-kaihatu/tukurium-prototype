import { type FieldSchemas, parseValue, stringifyValue } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import { fromFiles, toFiles } from "./files";
import {
  librarySnapshot,
  type PackageResolution,
  packageKokoStates,
  packageResourceId,
} from "./packageDependency";
import { packageManifest, stableStringify } from "./packageManifest";
import {
  packageEntityId,
  packageFieldSchemas,
  readPackageSnapshot,
  withPackagePrefabs,
} from "./packagePrefabs";
import { expandPrefabs, getPrefabOverride, prefabProblems } from "./prefab";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";
import type { PackageDependency } from "./schema";

const dep: PackageDependency = {
  alias: "parts",
  packageId: "w_parts",
  version: 2,
  contentHash: "h2",
};

function source() {
  const p = new ProjectDoc();
  p.load(emptyProject("部品"));
  const koko = p.addKokoState("Counter");
  p.updateKokoState({
    id: koko,
    name: "Counter",
    fields: [
      { id: "n", name: "n", type: "number", default: 1 },
      { id: "to", name: "to", type: "EntityRef | undefined", default: undefined },
      {
        id: "record",
        name: "record",
        type: "{ target: EntityRef; state: KokoStateRef<Counter> }",
        default: undefined,
      },
      { id: "material", name: "material", type: "MaterialRef | undefined", default: undefined },
      { id: "data", name: "data", type: "Map<string, bigint>", default: new Map([["a", 3n]]) },
    ],
  });
  const system = p.addSystem(
    "Step",
    'import Counter from "./Counter.koko";\nexport default system({ query: { with: [Counter] }, onUpdate(e) { e.get(Counter).n += 1; } });',
  );
  const material = p.addMaterial("色");
  const asset = "1234567890abcdef";
  p.addAsset({ id: asset, name: "画像", kind: "image", contentType: "image/png" });
  p.updateMaterial({
    ...(p.material(material) as NonNullable<ReturnType<ProjectDoc["material"]>>),
    map: asset,
  });
  const prefab = p.addPrefab("的");
  const root = p.prefab(prefab)?.root as string;
  const child = p.addPrefabEntity({
    prefab,
    name: "芯",
    states: {
      [koko]: {
        n: 7,
        to: root,
        record: { target: root, state: { entity: root, koko } },
        material,
        data: new Map([["a", 3n]]),
      },
    },
  });
  p.addState(root, koko, { n: 1, to: child });
  p.updatePrefab({
    ...(p.prefab(prefab) as NonNullable<ReturnType<ProjectDoc["prefab"]>>),
    systems: [{ id: system, enabled: true }],
    keep: [{ entity: child, koko, field: "n" }],
  });
  const library = p.addOutput("部品集", "library");
  p.setIncluded(library, prefab, true);
  const schemas: FieldSchemas = {
    [koko]: {
      record: {
        kind: "record",
        fields: [
          { name: "target", schema: { kind: "ref", target: "entity" }, optional: false },
          { name: "state", schema: { kind: "kokoRef", koko }, optional: false },
        ],
      },
    },
  };
  const ready = (dependency = dep): Extract<PackageResolution, { status: "ready" }> => ({
    status: "ready",
    dependency,
    manifest: packageManifest(p.snapshot(), library, schemas),
  });
  return { p, koko, system, material, asset, prefab, root, child, library, schemas, ready };
}

describe("ライブラリのプレハブ（ADR 0076）", () => {
  it("KokoState だけを公開したライブラリにも、公開元の型情報を残す", () => {
    const s = source();
    s.p.setIncluded(s.library, s.prefab, false);
    s.p.setIncluded(s.library, s.koko, true);
    const manifest = s.ready().manifest;
    expect(manifest.exports.some((e) => e.kind === "prefab")).toBe(false);
    expect(manifest.fieldSchemas).toEqual(s.schemas);
  });

  it("選んだプレハブの中身と使うものを公開し、関係のないものは含めない", () => {
    const s = source();
    const unused = s.p.addKokoState("Unused");
    const manifest = s.ready().manifest;
    expect(new Set(manifest.exports.map((e) => e.id))).toEqual(
      new Set([s.prefab, s.koko, s.system, s.material, s.asset]),
    );
    expect(manifest.exports.find((e) => e.id === s.prefab)?.definition).toMatchObject({
      root: s.root,
      entities: expect.arrayContaining([expect.objectContaining({ id: s.child })]),
    });
    expect(manifest.exports.some((e) => e.id === unused)).toBe(false);
    expect(manifest.fieldSchemas).toEqual(s.schemas);
  });

  it("外部 KokoState のフィールドが指すローカルの素材も公開する", () => {
    const s = source();
    const id = packageResourceId(dep, s.koko);
    const snapshot = s.p.snapshot();
    snapshot.kokostates = [];
    snapshot.dependencies = [dep];
    snapshot.prefabEntities = snapshot.prefabEntities?.map((e) => ({
      ...e,
      states: { [id]: { material: s.material } },
    }));
    const external = packageKokoStates([s.ready()]);
    // 型情報だけが届いた場合も、外部の定義から型を読む場合も、同じリソースを集める。
    const bySchema = packageManifest(snapshot, s.library, {
      [id]: { material: { kind: "ref", target: "material" } },
    });
    const byDefinition = packageManifest(snapshot, s.library, undefined, external);
    for (const manifest of [bySchema, byDefinition]) {
      expect(manifest.exports.map((e) => e.id)).toContain(s.material);
      expect(manifest.exports.map((e) => e.id)).toContain(s.asset);
      const wrapper = { ...dep, alias: "wrapper", packageId: "w_wrapper" };
      const loaded = withPackagePrefabs({ ...emptyProject("利用側"), dependencies: [wrapper] }, [
        s.ready(),
        { status: "ready", dependency: wrapper, manifest },
      ]);
      expect(loaded.materials.some((m) => m.id === packageResourceId(wrapper, s.material))).toBe(
        true,
      );
      expect(loaded.prefabEntities?.[0]?.states[id]?.material).toBe(
        packageResourceId(wrapper, s.material),
      );
    }
  });

  it("空文字・未指定の参照を保ち、プレハブがないライブラリの初期値も変えない", () => {
    const dependency: Extract<PackageResolution, { status: "ready" }> = {
      status: "ready",
      dependency: dep,
      manifest: {
        format: 1,
        exports: [
          {
            id: "refs",
            kind: "kokostate",
            path: "/Refs.koko",
            definition: {
              id: "refs",
              name: "Refs",
              fields: [
                { id: "material", name: "material", type: "MaterialRef", default: "" },
                { id: "entity", name: "entity", type: "EntityRef", default: "" },
                { id: "unset", name: "unset", type: "MaterialRef | undefined", default: undefined },
                { id: "texture", name: "texture", type: "TextureRef", default: "" },
              ],
            },
          },
        ],
      },
    };
    expect(packageKokoStates([dependency])[0]?.fields.map((f) => f.default)).toEqual([
      "",
      "",
      undefined,
      "",
    ]);
    dependency.manifest.exports.push({
      id: "prefab",
      kind: "prefab",
      path: "/Prefab.prefab",
      definition: {
        id: "prefab",
        name: "Prefab",
        root: "root",
        systems: [],
        keep: [],
        entities: [
          {
            id: "root",
            name: "root",
            prefab: "prefab",
            parent: null,
            order: 0,
            states: { refs: { material: "", entity: "", unset: undefined, texture: "" } },
          },
        ],
      },
    });
    expect(
      readPackageSnapshot(dependency).prefabEntities?.[0]?.states[packageResourceId(dep, "refs")],
    ).toEqual({ material: "", entity: "", unset: undefined, texture: "" });
  });

  it("依存先の素材を指す model・texture・audio と、マテリアルの map は hash を保つ", () => {
    const s = source();
    const snapshot = s.p.snapshot();
    snapshot.assets = [];
    snapshot.dependencies = [dep];
    snapshot.kokostates.push({
      id: "ks_texture",
      name: "Texture",
      fields: [{ id: "image", name: "image", type: "TextureRef", default: "" }],
    });
    snapshot.prefabEntities = snapshot.prefabEntities?.map((e) => ({
      ...e,
      states: {
        "builtin.Mesh": { model: s.asset, material: s.material },
        "builtin.AudioSource": { clip: s.asset },
        ks_texture: { image: s.asset },
      },
    }));
    const wrapper = { ...dep, alias: "wrapper", packageId: "w_wrapper" };
    const manifest = packageManifest(snapshot, s.library);
    const loaded = withPackagePrefabs({ ...emptyProject("利用側"), dependencies: [wrapper] }, [
      s.ready(),
      { status: "ready", dependency: wrapper, manifest },
    ]);
    expect(loaded.prefabEntities?.[0]?.states["builtin.Mesh"]?.model).toBe(s.asset);
    expect(loaded.prefabEntities?.[0]?.states["builtin.AudioSource"]?.clip).toBe(s.asset);
    expect(
      loaded.prefabEntities?.[0]?.states[packageResourceId(wrapper, "ks_texture")]?.image,
    ).toBe(s.asset);
    expect(loaded.materials.find((m) => m.id === packageResourceId(wrapper, s.material))?.map).toBe(
      s.asset,
    );
  });

  it("利用側の同名の型が、公開した参照の型を上書きしない", () => {
    const s = source();
    const def = s.p.kokostate(s.koko) as NonNullable<ReturnType<ProjectDoc["kokostate"]>>;
    s.p.updateKokoState({
      ...def,
      fields: [
        ...def.fields,
        { id: "ref", name: "ref", type: "KokoStateRef<Counter> | undefined", default: undefined },
      ],
    });
    s.p.setField(s.root, s.koko, "ref", { entity: s.root, koko: s.koko });
    s.schemas[s.koko] = {
      ...s.schemas[s.koko],
      ref: {
        kind: "union",
        options: [{ kind: "kokoRef", koko: s.koko }, { kind: "undefined" }],
      },
    };
    const snapshot = {
      ...emptyProject("利用側"),
      dependencies: [dep],
      kokostates: [{ id: "local_counter", name: "Counter", fields: [] }],
      entities: [
        {
          id: "instance",
          name: "instance",
          output: "out_main",
          parent: null,
          order: 0,
          states: {},
          instanceOf: { prefab: packageResourceId(dep, s.prefab) },
        },
      ],
    };
    const overrides: FieldSchemas = {
      [packageResourceId(dep, s.koko)]: {
        ref: {
          kind: "union",
          options: [{ kind: "kokoRef", koko: "local_counter" }, { kind: "undefined" }],
        },
      },
    };
    const schemas = packageFieldSchemas([s.ready()], overrides);
    const expanded = expandPrefabs(withPackagePrefabs(snapshot, [s.ready()], overrides, true), {
      schemas,
    });
    expect(
      expanded.entities.find((e) => e.id === "instance")?.states[packageResourceId(dep, s.koko)]
        ?.ref,
    ).toEqual({ entity: "instance", koko: packageResourceId(dep, s.koko) });
  });

  it("入れ子のプレハブも公開し、Entity の並びにかかわらず同じ hash の元になる", () => {
    const s = source();
    const inner = s.p.addPrefab("入れ子");
    s.p.addPrefabEntity({ prefab: s.prefab, name: "内側", instanceOf: { prefab: inner } });
    const snap = s.p.snapshot();
    const a = packageManifest(snap, s.library, s.schemas);
    const b = packageManifest(
      { ...snap, prefabEntities: [...(snap.prefabEntities ?? [])].reverse() },
      s.library,
      s.schemas,
    );
    expect(a.exports.some((e) => e.id === inner)).toBe(true);
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("版の ID へ付け替え、Entity・KokoState・マテリアルと入れ子の参照を保つ", () => {
    const s = source();
    const snap = librarySnapshot(s.ready());
    const id = (value: string) => packageResourceId(dep, value);
    const ent = (value: string) => packageEntityId(dep, value);
    const p = snap.prefabs?.find((p) => p.id === id(s.prefab));
    expect(p).toMatchObject({
      root: ent(s.root),
      systems: [{ id: id(s.system), enabled: true }],
      keep: [{ entity: ent(s.child), koko: id(s.koko), field: "n" }],
    });
    expect(ent(s.root)).not.toContain("/");
    const child = snap.prefabEntities?.find((e) => e.id === ent(s.child));
    expect(child).toMatchObject({
      prefab: id(s.prefab),
      parent: ent(s.root),
      states: {
        [id(s.koko)]: {
          to: ent(s.root),
          record: { target: ent(s.root), state: { entity: ent(s.root), koko: id(s.koko) } },
          material: id(s.material),
          data: new Map([["a", 3n]]),
        },
      },
    });
    expect(snap.materials[0]).toMatchObject({ id: id(s.material), map: s.asset });
    expect(snap.assets?.[0]?.id).toBe(s.asset);
    expect(packageFieldSchemas([s.ready()])[id(s.koko)]?.record).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ schema: { kind: "kokoRef", koko: id(s.koko) } }),
      ]),
    });
  });

  it("タグ付きの値も通信して読み戻せる", () => {
    const s = source();
    const encoded = stringifyValue(s.ready().manifest);
    const back = parseValue(encoded) as ReturnType<typeof s.ready>["manifest"];
    expect(librarySnapshot({ ...s.ready(), manifest: back })).toEqual(librarySnapshot(s.ready()));
  });

  it("入れ子のインスタンスで変えた所と、保持した System の ID も付け替える", () => {
    const s = source();
    const r = s.ready();
    const def = r.manifest.exports.find((e) => e.kind === "prefab")?.definition as {
      entities: Record<string, unknown>[];
      deletedParents?: Record<string, string | null>;
    };
    def.deletedParents = { removed: s.root };
    const child = def.entities.find((e) => e.id === s.child) as Record<string, unknown>;
    child.prefabOverrides = {
      "": { name: "そのままのキー" },
      [s.root]: {
        parent: s.child,
        states: { [s.koko]: { to: s.root } },
        addedStates: { [s.koko]: { to: s.child } },
      },
    };
    child.instanceSystems = [{ id: s.system, enabled: true }];
    child.unpackedSystems = [{ id: s.system, enabled: false }];
    const snap = librarySnapshot(r);
    const ent = (id: string) => packageEntityId(dep, id);
    const koko = packageResourceId(dep, s.koko);
    expect(snap.prefabs?.[0]).toMatchObject({ deletedParents: { [ent("removed")]: ent(s.root) } });
    expect(snap.prefabEntities?.find((e) => e.id === ent(s.child))).toMatchObject({
      prefabOverrides: {
        "": { name: "そのままのキー" },
        [ent(s.root)]: {
          parent: ent(s.child),
          states: { [koko]: { to: ent(s.root) } },
          addedStates: { [koko]: { to: ent(s.child) } },
        },
      },
      instanceSystems: [{ id: packageResourceId(dep, s.system), enabled: true }],
      unpackedSystems: [{ id: packageResourceId(dep, s.system), enabled: false }],
    });
  });

  it("選んだ版だけを読み、元が変わってもその版は変わらない", () => {
    const s = source();
    const old = s.ready();
    s.p.setField(s.child, s.koko, "n", 99);
    const newer = s.ready({ ...dep, version: 3, contentHash: "h3" });
    const snap = { ...emptyProject("作品"), dependencies: [dep] };
    const loaded = withPackagePrefabs(snap, [old, newer]);
    expect(loaded.prefabs?.map((p) => p.id)).toEqual([packageResourceId(dep, s.prefab)]);
    expect(
      loaded.prefabEntities?.find((e) => e.id === packageEntityId(dep, s.child))?.states[
        packageResourceId(dep, s.koko)
      ]?.n,
    ).toBe(7);
    expect(
      withPackagePrefabs({ ...snap, dependencies: [{ ...dep, contentHash: "wrong" }] }, [old])
        .prefabs,
    ).toEqual(snap.prefabs);
  });

  it("別のライブラリの中の Entity を指す上書きでは、元のバージョンの ID を保つ", () => {
    const s = source();
    const wrapper = { ...dep, packageId: "w_wrapper", alias: "wrapper" };
    const inner = packageEntityId(dep, s.child);
    const koko = packageResourceId(dep, s.koko);
    const outer: Extract<PackageResolution, { status: "ready" }> = {
      status: "ready",
      dependency: wrapper,
      manifest: {
        format: 1,
        dependencies: [dep],
        exports: [
          {
            kind: "prefab",
            id: "pf_outer",
            path: "/外側.prefab",
            definition: {
              id: "pf_outer",
              name: "外側",
              root: "outer_root",
              systems: [],
              keep: [],
              entities: [
                {
                  id: "outer_root",
                  name: "親",
                  parent: null,
                  order: 0,
                  prefab: "pf_outer",
                  states: {},
                },
                {
                  id: "instance",
                  name: "入れ子",
                  parent: "outer_root",
                  order: 0,
                  prefab: "pf_outer",
                  states: {},
                  instanceOf: { prefab: packageResourceId(dep, s.prefab) },
                  prefabOverrides: {
                    [inner]: {
                      states: {
                        [koko]: {
                          record: { target: "outer_root", state: { entity: "outer_root", koko } },
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const snap = withPackagePrefabs({ ...emptyProject("作品"), dependencies: [wrapper] }, [
      outer,
      s.ready(),
    ]);
    expect(
      snap.prefabEntities?.find((e) => e.id === packageEntityId(wrapper, "instance")),
    ).toMatchObject({
      prefabOverrides: {
        [inner]: {
          states: {
            [koko]: {
              record: {
                target: packageEntityId(wrapper, "outer_root"),
                state: { entity: packageEntityId(wrapper, "outer_root"), koko },
              },
            },
          },
        },
      },
    });
  });

  it("ローカルのインスタンスだけ保存し、読み戻して同じ版で展開できる", () => {
    const s = source();
    const p = new ProjectDoc();
    p.load(emptyProject("作品"));
    p.addDependency(dep);
    p.setPackagePrefabs([s.ready()]);
    p.setPackageKokoStates(packageKokoStates([s.ready()]));
    const id = p.addInstance({
      output: "out_main",
      prefab: packageResourceId(dep, s.prefab),
      position: [3, 0, 0],
    });
    const expanded = expandPrefabs(p.snapshotWithPackages(), { schemas: p.prefabFieldSchemas() });
    expect(prefabProblems(p.snapshotWithPackages())).toEqual([]);
    expect(
      expanded.entities.find((e) => e.id === `${id}/${packageEntityId(dep, s.child)}`)?.states[
        packageResourceId(dep, s.koko)
      ],
    ).toMatchObject({
      to: id,
      record: { target: id, state: { entity: id, koko: packageResourceId(dep, s.koko) } },
    });
    expect(p.snapshot().prefabs).toEqual([]);
    expect(p.snapshot().prefabEntities).toEqual([]);
    expect(p.prefabs()).toEqual([]);
    const back = fromFiles(toFiles(p.snapshot()));
    expect(back.entities[0]?.instanceOf).toEqual({ prefab: packageResourceId(dep, s.prefab) });
    expect(back.dependencies).toEqual([dep]);
    expect(
      expandPrefabs(withPackagePrefabs(back, [s.ready()]), {
        kokostates: packageKokoStates([s.ready()]),
        schemas: packageFieldSchemas([s.ready()]),
      }).entities,
    ).toEqual(expanded.entities);
  });

  it("ライブラリの定義には書き込めず、読み込んだ中身も次の load に残らない", () => {
    const s = source();
    const p = new ProjectDoc();
    p.load({ ...emptyProject("作品"), dependencies: [dep] });
    p.setPackagePrefabs([s.ready()]);
    const prefab = p.prefab(packageResourceId(dep, s.prefab));
    expect(prefab).toBeDefined();
    expect(() => p.restorePrefab(prefab as NonNullable<typeof prefab>, [])).toThrow(/ライブラリ/);
    expect(() => p.setField(packageEntityId(dep, s.child), s.koko, "n", 10)).toThrow();
    p.updatePrefab({ ...(prefab as NonNullable<typeof prefab>), name: "書けない" });
    expect(p.prefab(packageResourceId(dep, s.prefab))?.name).toBe("的");
    p.load(emptyProject("次の作品"));
    expect(p.prefab(packageResourceId(dep, s.prefab))).toBeUndefined();
  });

  it("ライブラリのインスタンスでも、値と追加分を変えて一つずつ戻せる", () => {
    const s = source();
    const doc = new ProjectDoc();
    doc.load({ ...emptyProject("作品"), dependencies: [dep] });
    doc.setPackagePrefabs([s.ready()]);
    doc.setPackageKokoStates(packageKokoStates([s.ready()]));
    const instance = doc.addInstance({
      output: "out_main",
      prefab: packageResourceId(dep, s.prefab),
    });
    const child = `${instance}/${packageEntityId(dep, s.child)}`;
    const koko = packageResourceId(dep, s.koko);
    const expanded = () =>
      expandPrefabs(doc.snapshotWithPackages(), { schemas: doc.prefabFieldSchemas() });
    const at = (id: string) => expanded().entities.find((e) => e.id === id);
    doc.setField(instance, koko, "n", 42);
    doc.setField(child, koko, "n", 84);
    expect(at(instance)?.states[koko]?.n).toBe(42);
    expect(at(child)?.states[koko]?.n).toBe(84);
    expect(getPrefabOverride(doc.snapshotWithPackages(), child)?.states?.[koko]?.n).toBe(84);
    const added = doc.addKokoState("Added");
    doc.addState(child, added);
    const extra = doc.addEntity({ output: "out_main", name: "追加", parent: child });
    expect(at(extra)?.parent).toBe(child);
    expect(at(child)?.states[added]).toEqual({});
    expect(() => doc.removeState(child, koko)).toThrow(/プレハブから/);
    expect(() => doc.removeEntity(child)).toThrow(/プレハブから/);
    doc.removeState(child, added);
    doc.removeEntity(extra);
    doc.revertPrefabField(instance, koko, "n");
    doc.revertPrefabField(child, koko, "n");
    expect(at(instance)?.states[koko]?.n).toBe(1);
    expect(at(child)?.states[koko]?.n).toBe(7);
    expect(doc.snapshot().prefabs).toEqual([]);
    expect(doc.snapshot().prefabEntities).toEqual([]);
  });

  it("ライブラリへの適用は拒み、解除では現在の値・参照・入れ子をローカルに残す", () => {
    const s = source();
    const inner = s.p.addPrefab("入れ子");
    const nested = s.p.addPrefabEntity({
      prefab: s.prefab,
      name: "入れ子",
      instanceOf: { prefab: inner },
    });
    const doc = new ProjectDoc();
    doc.load({ ...emptyProject("作品"), dependencies: [dep] });
    doc.setPackagePrefabs([s.ready()]);
    doc.setPackageKokoStates(packageKokoStates([s.ready()]));
    const instance = doc.addInstance({
      output: "out_main",
      prefab: packageResourceId(dep, s.prefab),
    });
    const child = `${instance}/${packageEntityId(dep, s.child)}`;
    const koko = packageResourceId(dep, s.koko);
    doc.setField(child, koko, "n", 84);
    const extra = doc.addEntity({ output: "out_main", name: "追加", parent: child });
    const before = doc.snapshot();
    expect(doc.planApplyPrefabInstance(instance)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ライブラリ"),
    });
    expect(() => doc.applyPrefabInstance(instance)).toThrow(/ライブラリ/);
    expect(doc.snapshot()).toEqual(before);
    const planned = doc.planUnpackPrefabInstance(instance);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const plan = doc.unpackPrefabInstance(instance, { ids: planned.plan.ids });
    const materializedChild = plan.ids[packageEntityId(dep, s.child)] as string;
    const materializedNested = plan.ids[packageEntityId(dep, nested)] as string;
    expect(doc.entity(instance)?.instanceOf).toBeUndefined();
    expect(doc.entity(instance)?.unpackedSystems).toEqual([
      { id: packageResourceId(dep, s.system), enabled: true },
    ]);
    expect(doc.entity(materializedChild)?.states[koko]).toMatchObject({
      n: 84,
      to: instance,
      record: { target: instance, state: { entity: instance, koko } },
    });
    expect(doc.entity(extra)?.parent).toBe(materializedChild);
    expect(doc.entity(materializedNested)?.instanceOf).toEqual({
      prefab: packageResourceId(dep, inner),
    });
    expect(doc.prefab(packageResourceId(dep, s.prefab))?.root).toBe(packageEntityId(dep, s.root));
    expect(doc.snapshot().prefabs).toEqual([]);
    expect(doc.snapshot().prefabEntities).toEqual([]);
    expect(new Map(fromFiles(toFiles(doc.snapshot())).entities.map((e) => [e.id, e]))).toEqual(
      new Map(doc.snapshot().entities.map((e) => [e.id, e])),
    );
  });

  it("ローカルのプレハブへライブラリを入れ、外側へ適用してから内側を解除できる", () => {
    const s = source();
    const doc = new ProjectDoc();
    doc.load({ ...emptyProject("作品"), dependencies: [dep] });
    doc.setPackagePrefabs([s.ready()]);
    doc.setPackageKokoStates(packageKokoStates([s.ready()]));
    const board = doc.addPrefab("盤");
    const slot = doc.addInstance({ ownerPrefab: board, prefab: packageResourceId(dep, s.prefab) });
    const first = doc.addInstance({ output: "out_main", prefab: board });
    const second = doc.addInstance({ output: "out_main", prefab: board });
    const child = packageEntityId(dep, s.child);
    const koko = packageResourceId(dep, s.koko);
    const expanded = () =>
      expandPrefabs(doc.snapshotWithPackages(), { schemas: doc.prefabFieldSchemas() });
    const at = (id: string) => expanded().entities.find((e) => e.id === id);
    doc.setField(`${first}/${slot}/${child}`, koko, "n", 99);
    doc.applyPrefabInstance(first);
    expect(at(`${second}/${slot}/${child}`)?.states[koko]?.n).toBe(99);
    expect(doc.prefabEntity(child)?.states[koko]?.n).toBe(7);
    expect(doc.planApplyPrefabInstance(slot)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ライブラリ"),
    });
    const unlinked = doc.unpackPrefabInstance(slot);
    const localChild = unlinked.ids[child] as string;
    expect(doc.prefabEntity(slot)?.instanceOf).toBeUndefined();
    expect(at(`${first}/${localChild}`)?.states[koko]?.n).toBe(99);
    expect(at(`${second}/${localChild}`)?.states[koko]?.n).toBe(99);
    expect(doc.prefabEntity(localChild)?.states[koko]?.to).toBe(slot);
    expect(doc.prefabs().map((p) => p.id)).toEqual([board]);
    expect(doc.prefabEntity(child)?.states[koko]?.n).toBe(7);
  });
});
