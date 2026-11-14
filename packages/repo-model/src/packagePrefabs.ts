import {
  type FieldSchemas,
  type FieldValue,
  type KokoStateDef,
  mapRefs,
  schemaOfField,
} from "@tukurium/eks";
import { BUILTIN_KOKOSTATES, isBuiltin } from "./builtins";
import {
  isPackageResourceId,
  type PackageResolution,
  packageResourceId,
  reachablePackages,
} from "./packageDependency";
import type { PackagePrefabDefinition } from "./packageManifest";
import type { EntityBase, PackageDependency, ProjectSnapshot } from "./schema";

/** 中の Entity は、展開した ID の区切り（/）を含まない名前にする。 */
export const packageEntityId = (dep: PackageDependency, id: string): string =>
  `pkgent:${encodeURIComponent(dep.packageId)}@${dep.version}:${encodeURIComponent(id)}`;

/** ライブラリの公開した中身を、版ごとに区切った ID で読む。 */
export function readPackageSnapshot(
  r: Extract<PackageResolution, { status: "ready" }>,
  schemas?: FieldSchemas,
  externalDefinitions: readonly KokoStateDef[] = [],
): ProjectSnapshot {
  const dep = r.dependency;
  const snap: ProjectSnapshot = {
    version: 1,
    name: dep.alias,
    kokostates: [],
    systems: [],
    types: [],
    materials: [],
    assets: [],
    outputs: [],
    entities: [],
    folders: [],
    placement: {},
    prefabs: [],
    prefabEntities: [],
  };
  const assets = new Set(r.manifest.exports.filter((e) => e.kind === "asset").map((e) => e.id));
  // 素材の ID はファイルの hash。取得 URL も同じ ID を使うので、版で区切らない。
  const resource = (id: string) =>
    id === "" || isBuiltin(id) || isPackageResourceId(id) || assets.has(id)
      ? id
      : packageResourceId(dep, id);
  const entity = (id: string) =>
    id === ""
      ? id
      : id
          .split("/")
          .map((part) => (part.startsWith("pkgent:") ? part : packageEntityId(dep, part)))
          .join("/");
  const defs = new Map<string, KokoStateDef>(
    [...BUILTIN_KOKOSTATES, ...externalDefinitions].map((k) => [k.id, k]),
  );
  for (const e of r.manifest.exports)
    if (e.kind === "kokostate") {
      const def = e.definition as KokoStateDef;
      if (Array.isArray(def?.fields)) defs.set(e.id, def);
    }
  const remapValues = (koko: string, values: EntityBase["states"][string]) => {
    const next = structuredClone(values);
    for (const f of defs.get(koko)?.fields ?? []) {
      const schema =
        schemaOfField(r.manifest.fieldSchemas, koko, f) ??
        schemaOfField(schemas, resource(koko), f);
      if (schema && Object.hasOwn(next, f.id))
        next[f.id] = mapRefs(schema, next[f.id], (target, id) =>
          target === "entity"
            ? entity(id)
            : target === "material" || target === "kokostate"
              ? resource(id)
              : id,
        ) as FieldValue;
    }
    return next;
  };
  const remapEntity = <T extends EntityBase>(e: T): T => ({
    ...structuredClone(e),
    id: entity(e.id),
    parent: e.parent === null ? null : entity(e.parent),
    states: Object.fromEntries(
      Object.entries(e.states).map(([k, v]) => [resource(k), remapValues(k, v)]),
    ),
    ...(e.instanceOf
      ? { instanceOf: { ...e.instanceOf, prefab: resource(e.instanceOf.prefab) } }
      : {}),
    ...remapOverrides(e),
  });
  const remapStates = (states: EntityBase["states"]) =>
    Object.fromEntries(Object.entries(states).map(([k, v]) => [resource(k), remapValues(k, v)]));
  const remapOverrides = (e: EntityBase) => ({
    ...(e.prefabOverrides
      ? {
          prefabOverrides: Object.fromEntries(
            Object.entries(e.prefabOverrides).map(([key, value]) => [
              key === "" ? "" : entity(key),
              {
                ...structuredClone(value),
                ...(value.states ? { states: remapStates(value.states) } : {}),
                ...(value.addedStates ? { addedStates: remapStates(value.addedStates) } : {}),
                ...(value.parent !== undefined
                  ? { parent: value.parent === null ? null : entity(value.parent) }
                  : {}),
              },
            ]),
          ),
        }
      : {}),
    ...(e.instanceSystems
      ? { instanceSystems: e.instanceSystems.map((s) => ({ ...s, id: resource(s.id) })) }
      : {}),
    ...(e.unpackedSystems
      ? { unpackedSystems: e.unpackedSystems.map((s) => ({ ...s, id: resource(s.id) })) }
      : {}),
  });
  const folders = new Map<string, NonNullable<ProjectSnapshot["folders"]>[number]>();
  for (const e of r.manifest.exports) {
    const def = e.definition as Record<string, unknown> | null;
    if (typeof def?.name !== "string") continue;
    let parent: string | null = null;
    let prefix = "";
    for (const name of e.path.split("/").filter(Boolean).slice(0, -1)) {
      prefix += `/${name}`;
      const id = `pkgdir:${dep.packageId}@${dep.version}:${prefix}`;
      folders.set(id, { id, name, parent });
      parent = id;
    }
    const id = resource(e.id);
    if (e.kind === "kokostate" && Array.isArray(def.fields)) {
      const k = structuredClone(def) as unknown as KokoStateDef;
      snap.kokostates.push({
        ...k,
        id,
        fields: k.fields.map((f) => ({
          ...f,
          default: remapValues(e.id, { [f.id]: f.default })[f.id],
        })),
        ...(k.typeDefs ? { typeDefs: k.typeDefs.map(resource) } : {}),
      });
    } else if (e.kind === "system" && typeof def.code === "string")
      snap.systems.push({ id, name: def.name, code: def.code });
    else if (e.kind === "typedef" && typeof def.code === "string")
      snap.types?.push({ id, name: def.name, code: def.code });
    else if (e.kind === "material") {
      const m = structuredClone(def) as unknown as ProjectSnapshot["materials"][number];
      snap.materials.push({ ...m, id });
    } else if (e.kind === "asset")
      snap.assets?.push({
        ...(structuredClone(def) as unknown as NonNullable<ProjectSnapshot["assets"]>[number]),
        id,
      });
    else if (
      e.kind === "prefab" &&
      typeof def.root === "string" &&
      Array.isArray(def.entities) &&
      Array.isArray(def.systems) &&
      Array.isArray(def.keep)
    ) {
      const { entities, ...p } = structuredClone(def) as unknown as PackagePrefabDefinition;
      const deletedParents = p.deletedParents;
      snap.prefabs?.push({
        ...p,
        id,
        root: entity(p.root),
        systems: p.systems.map((s) => ({ ...s, id: resource(s.id) })),
        keep: p.keep.map((k) => ({ ...k, entity: entity(k.entity), koko: resource(k.koko) })),
        ...(deletedParents
          ? {
              deletedParents: Object.fromEntries(
                Object.entries(deletedParents).map(([id, parent]) => [
                  entity(id),
                  parent === null ? null : entity(parent),
                ]),
              ),
            }
          : {}),
      });
      snap.prefabEntities?.push(...entities.map((e) => ({ ...remapEntity(e), prefab: id })));
    } else continue;
    if (parent && snap.placement) snap.placement[id] = parent;
  }
  snap.folders = [...folders.values()];
  return snap;
}

/** 保存するデータは変えず、表示・展開・再生のために選んだ版のリソースを合わせる。 */
export function withPackagePrefabs(
  snapshot: ProjectSnapshot,
  packages: readonly PackageResolution[] | undefined,
  schemas?: FieldSchemas,
  includeDefinitions = false,
): ProjectSnapshot {
  const ready = reachablePackages(snapshot.dependencies, packages);
  const combinedSchemas = packageFieldSchemas(ready, schemas);
  const definitions = ready.flatMap((r) => readPackageSnapshot(r).kokostates);
  const libraries = ready.map((r) => readPackageSnapshot(r, combinedSchemas, definitions));
  if (libraries.length === 0) return snapshot;
  const merge = <T extends { id: string }>(own: T[], more: T[]): T[] => [
    ...new Map([...more, ...own].map((v) => [v.id, v])).values(),
  ];
  return {
    ...snapshot,
    kokostates: includeDefinitions
      ? merge(
          snapshot.kokostates,
          libraries.flatMap((s) => s.kokostates),
        )
      : snapshot.kokostates,
    systems: includeDefinitions
      ? merge(
          snapshot.systems,
          libraries.flatMap((s) => s.systems),
        )
      : snapshot.systems,
    types: includeDefinitions
      ? merge(
          snapshot.types ?? [],
          libraries.flatMap((s) => s.types ?? []),
        )
      : snapshot.types,
    materials: merge(
      snapshot.materials,
      libraries.flatMap((s) => s.materials),
    ),
    assets: merge(
      snapshot.assets ?? [],
      libraries.flatMap((s) => s.assets ?? []),
    ),
    prefabs: merge(
      snapshot.prefabs ?? [],
      libraries.flatMap((s) => s.prefabs ?? []),
    ),
    prefabEntities: merge(
      snapshot.prefabEntities ?? [],
      libraries.flatMap((s) => s.prefabEntities ?? []),
    ),
  };
}

/** 公開した型情報の KokoState ID を、選んだ版の ID にする。 */
export function packageFieldSchemas(
  resolutions: Iterable<PackageResolution>,
  fallback?: FieldSchemas,
): FieldSchemas {
  const result: FieldSchemas = {};
  for (const r of resolutions) {
    if (r.status !== "ready") continue;
    const resource = (id: string) =>
      isBuiltin(id) || isPackageResourceId(id) ? id : packageResourceId(r.dependency, id);
    const map = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(map);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [
          key,
          key === "koko" && typeof val === "string" ? resource(val) : map(val),
        ]),
      );
    };
    for (const [id, fields] of Object.entries(r.manifest.fieldSchemas ?? {}))
      result[resource(id)] = map(fields) as FieldSchemas[string];
  }
  // 公開したバージョンの型は変えない。利用側の同名の型による再解釈を避ける。
  for (const [id, fields] of Object.entries(fallback ?? {}))
    result[id] = { ...fields, ...result[id] };
  return result;
}
