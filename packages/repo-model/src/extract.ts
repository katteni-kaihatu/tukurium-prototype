import {
  equalValues,
  type FieldSchemas,
  type FieldValue,
  type KokoStateDef,
  mapRefs,
  schemaOfField,
} from "@tukurium/eks";
import { BUILTIN_KOKOSTATES, isBuiltin } from "./builtins";
import { ProjectDependencyGraph } from "./dependencyGraph";
import { lockKey, parsePackageResourceId, parsePackageSpelling } from "./packageDependency";
import { ResourcePathIndex } from "./resourcePath";
import {
  type FolderDef,
  newId,
  type PackageDependency,
  type ProjectSnapshot,
  type Provenance,
} from "./schema";
import { compileSystem, rewriteImports } from "./systemCompiler";

export interface ExtractSelection {
  outputs: string[];
  kokostates: string[];
  systems: string[];
  materials: string[];
  assets: string[];
  /** 型の定義（ADR 0065）。選んだ KokoState が使うものは、選ばなくても一緒に集まる */
  types?: string[];
}

export interface ExtractSource {
  repoId: string;
  repoName: string;
  commit: string;
}

/**
 * 選んだアウトプット・リソースを、依存するもの（Entity・System・KokoState・マテリアル・素材）ごと集める。
 */
export function collectSelection(
  src: ProjectSnapshot,
  sel: ExtractSelection,
  /** 取り出し元のフィールドのスキーマ（あれば、入れ子の中の参照が指すものも集める） */
  schemas?: FieldSchemas,
): ExtractSelection {
  const out = {
    outputs: new Set(sel.outputs),
    kokostates: new Set(sel.kokostates),
    systems: new Set(sel.systems),
    materials: new Set(sel.materials),
    assets: new Set(sel.assets),
    types: new Set(sel.types ?? []),
  };
  for (const o of src.outputs) {
    if (!out.outputs.has(o.id)) continue;
    for (const s of o.systems) out.systems.add(s.id);
    // ライブラリに含めたリソース（ADR 0055）
    for (const id of o.resources ?? []) {
      if (src.kokostates.some((k) => k.id === id)) out.kokostates.add(id);
      else if (src.systems.some((x) => x.id === id)) out.systems.add(id);
      else if (src.materials.some((m) => m.id === id)) out.materials.add(id);
      else if ((src.assets ?? []).some((a) => a.id === id)) out.assets.add(id);
      else if ((src.types ?? []).some((t) => t.id === id)) out.types.add(id);
    }
  }
  // Entity と System が使うものは、依存グラフから集める（計画 Phase 3）
  const graph = ProjectDependencyGraph.fromSnapshot(src, schemas);
  const assetIds = new Set((src.assets ?? []).map((a) => a.id));
  for (const e of src.entities) {
    if (!out.outputs.has(e.output)) continue;
    // 持っている KokoState と、欄で指しているマテリアル・素材（Built-in も自作の KokoState の欄も）
    for (const dep of graph.dependenciesOf({ kind: "entity", id: e.id })) {
      if (dep.kind === "kokostate" && !isBuiltin(dep.id)) out.kokostates.add(dep.id);
      else if (dep.kind === "material") out.materials.add(dep.id);
      else if (dep.kind === "asset") out.assets.add(dep.id);
    }
    // 定義がこのプロジェクトにない KokoState（ライブラリのもの）の欄は、グラフでは読めないので、
    // 素材の ID と同じ文字列を拾う
    for (const [koko, values] of Object.entries(e.states)) {
      if (src.kokostates.some((k) => k.id === koko) || isBuiltin(koko)) continue;
      for (const v of Object.values(values))
        if (typeof v === "string" && assetIds.has(v)) out.assets.add(v);
    }
  }
  // System が使う KokoState（import したもの）
  for (const s of src.systems) {
    if (!out.systems.has(s.id)) continue;
    for (const dep of graph.dependenciesOf({ kind: "system", id: s.id })) {
      if (dep.kind === "kokostate" && !isBuiltin(dep.id)) out.kokostates.add(dep.id);
    }
  }
  // マテリアルが使う画像
  for (const id of out.materials)
    for (const dep of graph.dependenciesOf({ kind: "material", id }))
      if (dep.kind === "asset") out.assets.add(dep.id);
  // KokoState がフィールドの型で使う、型の定義（ライブラリのものは、依存で持ってくる）
  for (const id of out.kokostates)
    for (const dep of graph.dependenciesOf({ kind: "kokostate", id }))
      if (dep.kind === "typedef" && !parsePackageResourceId(dep.id)) out.types.add(dep.id);
  return {
    outputs: [...out.outputs],
    kokostates: [...out.kokostates],
    systems: [...out.systems],
    materials: [...out.materials],
    assets: [...out.assets],
    types: [...out.types],
  };
}

/**
 * 抽出：選んだもの（依存を含む）を、取り込み先の制作データに加える（取り込み先がなければ新しく作る）。
 * - 取り込み先に同じ ID で同じ中身があれば、そのまま使う。中身が違えば新しい ID を振り直す。
 * - KokoState の名前がぶつかったら名前を付け替え、取り出した System のコードの名前も書き換える。
 * - 取り出したものが入っていたフォルダも作り（同じパスのフォルダがあればそれを使う）、
 *   System の import を取り込み先の構造に合わせて書き直す（ADR 0010 §3）。
 * - 取り出したものが使うライブラリ（依存）も持ってくる。取り込み先に同じ lock があればその別名を使い、
 *   別名がほかのものとぶつかれば付け替えて import も書き直す。別の版は共存させる（ADR 0015）。
 * - 由来（元のリポジトリ・コミット・取り出したもの・持ってきた依存）を provenance に残す。
 */
export function extractInto(
  src: ProjectSnapshot,
  selection: ExtractSelection,
  source: ExtractSource,
  target: ProjectSnapshot | null,
  name?: string,
  /** 取り出し元のフィールドのスキーマ（あれば、入れ子の中の参照も新しい ID に付け替える） */
  schemas?: FieldSchemas,
): ProjectSnapshot {
  const sel = collectSelection(src, selection, schemas);
  const srcDefs = new Map([...BUILTIN_KOKOSTATES, ...src.kokostates].map((k) => [k.id, k]));
  const dst: ProjectSnapshot = target
    ? structuredClone(target)
    : {
        version: 1,
        name: name ?? src.name,
        kokostates: [],
        systems: [],
        materials: [],
        assets: [],
        outputs: [],
        entities: [],
      };
  dst.assets ??= [];
  dst.folders ??= [];
  dst.placement ??= {};
  const remap = new Map<string, string>();
  /** 取り込み先に新しく足したリソース（取り出し元の ID → 取り込み先の ID）。フォルダの置き場所を写す */
  const added = new Map<string, string>();
  const same = (a: unknown, b: unknown) => equalValues(a, b);

  // 型の定義（KokoState が ID で指すので、先に入れて、振り直した ID を決める）
  dst.types ??= [];
  for (const id of sel.types ?? []) {
    const item = (src.types ?? []).find((t) => t.id === id);
    if (!item) continue;
    const existing = dst.types.find((t) => t.id === id);
    if (existing && same(existing, item)) continue;
    const next = structuredClone(item);
    if (existing) {
      next.id = newId("td");
      remap.set(id, next.id);
    }
    dst.types.push(next);
    added.set(id, next.id);
  }

  // KokoState（名前の衝突も解く）
  const renamed = new Map<string, string>();
  for (const id of sel.kokostates) {
    const def = src.kokostates.find((k) => k.id === id);
    if (!def) continue;
    const existing = dst.kokostates.find((k) => k.id === id);
    if (existing && same(existing, def)) continue;
    const next: KokoStateDef = structuredClone(def);
    if (next.typeDefs) next.typeDefs = next.typeDefs.map((t) => remap.get(t) ?? t);
    if (existing || dst.kokostates.some((k) => k.id === next.id)) {
      next.id = newId("ks");
      remap.set(id, next.id);
    }
    let n = 2;
    const base = next.name;
    while (dst.kokostates.some((k) => k.name === next.name)) next.name = `${base}_${n++}`;
    if (next.name !== base) renamed.set(base, next.name);
    dst.kokostates.push(next);
    added.set(id, next.id);
  }

  const copyById = <T extends { id: string }>(
    list: T[],
    into: T[],
    ids: string[],
    prefix: string,
  ) => {
    for (const id of ids) {
      const item = list.find((x) => x.id === id);
      if (!item) continue;
      const existing = into.find((x) => x.id === id);
      if (existing && same(existing, item)) continue;
      const next = structuredClone(item);
      if (existing) {
        next.id = newId(prefix);
        remap.set(id, next.id);
      }
      into.push(next);
      added.set(id, next.id);
    }
  };
  copyById(src.materials, dst.materials, sel.materials, "mat");
  copyById(src.assets ?? [], dst.assets, sel.assets, "asset");

  for (const id of sel.systems) {
    if (parsePackageResourceId(id)) continue; // ライブラリの System は依存で持ってくる
    const s = src.systems.find((x) => x.id === id);
    if (!s) continue;
    let code = s.code;
    for (const [from, to] of renamed)
      code = code.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`.${from}.`, `.${to}.`);
    const next = { ...s, code };
    const existing = dst.systems.find((x) => x.id === id);
    if (existing && same(existing, next)) continue;
    if (existing) {
      next.id = newId("sys");
      remap.set(id, next.id);
    }
    dst.systems.push(next);
    added.set(id, next.id);
  }

  const aliases = carryDependencies(src, sel, dst);
  copyFolders(src, dst, added);

  const r = (id: string) => remap.get(id) ?? id;
  for (const oid of sel.outputs) {
    const o = src.outputs.find((x) => x.id === oid);
    if (!o) continue;
    const newOut = dst.outputs.some((x) => x.id === oid) ? newId("out") : oid;
    const entityIds = new Map<string, string>();
    for (const e of src.entities.filter((x) => x.output === oid)) {
      entityIds.set(e.id, dst.entities.some((x) => x.id === e.id) ? newId("ent") : e.id);
    }
    dst.outputs.push({
      ...structuredClone(o),
      id: newOut,
      systems: o.systems.map((s) => ({ ...s, id: r(s.id) })),
      ...(o.resources ? { resources: o.resources.map(r).sort() } : {}),
      keep: o.keep.map((k) => ({
        ...k,
        entity: entityIds.get(k.entity) ?? k.entity,
        koko: r(k.koko),
      })),
    });
    for (const e of src.entities.filter((x) => x.output === oid)) {
      const states: typeof e.states = {};
      for (const [koko, values] of Object.entries(e.states)) {
        const v = structuredClone(values);
        // 参照が指す ID を、取り込み先で振り直した ID に付け替える
        for (const f of srcDefs.get(koko)?.fields ?? []) {
          const schema = schemaOfField(schemas, koko, f);
          if (!schema || !Object.hasOwn(v, f.id)) continue;
          v[f.id] = mapRefs(schema, v[f.id], (refTarget, id) =>
            refTarget === "entity" ? entityIds.get(id) : remap.get(id),
          ) as FieldValue;
        }
        states[r(koko)] = v;
      }
      dst.entities.push({
        ...structuredClone(e),
        id: entityIds.get(e.id) ?? e.id,
        parent: e.parent ? (entityIds.get(e.parent) ?? e.parent) : null,
        output: newOut,
        states,
      });
    }
  }

  const names = [
    ...sel.outputs.map((id) => src.outputs.find((o) => o.id === id)?.name ?? id),
    ...selection.kokostates.map((id) => src.kokostates.find((k) => k.id === id)?.name ?? id),
    ...selection.systems.map((id) => src.systems.find((s) => s.id === id)?.name ?? id),
    ...selection.materials.map((id) => src.materials.find((m) => m.id === id)?.name ?? id),
    ...selection.assets.map((id) => src.assets?.find((a) => a.id === id)?.name ?? id),
    ...(selection.types ?? []).map((id) => src.types?.find((t) => t.id === id)?.name ?? id),
  ];
  rebindImports(src, dst, added, aliases.map);
  const index = ResourcePathIndex.fromSnapshot(src);
  const paths = [
    ...selection.kokostates,
    ...selection.systems,
    ...selection.materials,
    ...selection.assets,
    ...(selection.types ?? []),
  ]
    .map((id) => index.pathOf(id))
    .filter((p): p is string => p !== null);
  const record: Provenance = {
    kind: "extract",
    repoId: source.repoId,
    repoName: source.repoName,
    commit: source.commit,
    items: [...new Set(names)],
    ...(paths.length > 0 ? { paths: [...new Set(paths)] } : {}),
    ...(aliases.carried.length > 0 ? { dependencies: aliases.carried } : {}),
    at: new Date().toISOString(),
  };
  dst.provenance = [...(dst.provenance ?? []), record];
  return dst;
}

/**
 * 取り出したもの（Entity の KokoState・アウトプットの System・System の `@別名` の import）が使う依存を、
 * 取り込み先へ持ってくる。返すのは、取り出し元の別名 → 取り込み先の別名と、新しく足した依存。
 */
function carryDependencies(
  src: ProjectSnapshot,
  sel: ExtractSelection,
  dst: ProjectSnapshot,
): { map: Map<string, string>; carried: PackageDependency[] } {
  const srcDeps = src.dependencies ?? [];
  const needed = new Set<string>();
  const byId = (id: string) => {
    const ref = parsePackageResourceId(id);
    const d = ref
      ? srcDeps.find((x) => x.packageId === ref.packageId && x.version === ref.version)
      : undefined;
    if (d) needed.add(d.alias);
  };
  for (const o of src.outputs) {
    if (!sel.outputs.includes(o.id)) continue;
    for (const s of o.systems) byId(s.id);
    for (const e of src.entities)
      if (e.output === o.id) for (const k of Object.keys(e.states)) byId(k);
  }
  let index: ResourcePathIndex | null = null;
  for (const s of src.systems) {
    if (!sel.systems.includes(s.id) || !s.code.includes("@")) continue;
    index ??= ResourcePathIndex.fromSnapshot(src);
    for (const alias of compileSystem(s.id, s.code, index).packageImports) needed.add(alias);
  }

  const map = new Map<string, string>();
  const carried: PackageDependency[] = [];
  dst.dependencies = [...(dst.dependencies ?? [])];
  for (const dep of srcDeps) {
    if (!needed.has(dep.alias)) continue;
    const same = dst.dependencies.find((d) => lockKey(d) === lockKey(dep));
    if (same) {
      map.set(dep.alias, same.alias);
      continue;
    }
    // 別名がほかのもの（別のライブラリ・別の版）とぶつかれば付け替える
    let alias = dep.alias;
    for (let n = 2; dst.dependencies.some((d) => d.alias === alias); n++)
      alias = `${dep.alias}_${n}`;
    const next = { ...dep, alias };
    dst.dependencies.push(next);
    carried.push(next);
    map.set(dep.alias, alias);
  }
  dst.dependencies.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  return { map, carried };
}

/** 新しく足したリソースを、取り出し元と同じパスのフォルダへ置く（なければ作る。同じパスがあれば使う） */
function copyFolders(src: ProjectSnapshot, dst: ProjectSnapshot, added: Map<string, string>): void {
  const srcFolders = new Map((src.folders ?? []).map((f) => [f.id, f] as const));
  const folders = dst.folders as FolderDef[];
  const placement = dst.placement as Record<string, string>;
  /** 取り出し元のフォルダの名前を、いちばん上から並べたもの（輪なら null） */
  const chain = (folder: string | undefined): string[] | null => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (
      let f = folder ? srcFolders.get(folder) : undefined;
      f;
      f = srcFolders.get(f.parent ?? "")
    ) {
      if (seen.has(f.id)) return null;
      seen.add(f.id);
      names.unshift(f.name);
      if (f.parent === null) break;
    }
    return names;
  };
  const ensure = (names: string[]): string | null => {
    let parent: string | null = null;
    for (const name of names) {
      const hit = folders.find((f) => f.parent === parent && f.name === name);
      if (hit) {
        parent = hit.id;
        continue;
      }
      const id = newId("fld");
      folders.push({ id, name, parent });
      parent = id;
    }
    return parent;
  };
  for (const [from, to] of added) {
    const names = chain(src.placement?.[from]);
    if (!names || names.length === 0) continue;
    const folder = ensure(names);
    if (folder) placement[to] = folder;
  }
}

/**
 * 取り出した System の import を、取り込み先の構造と依存の別名に合わせて書き直す。
 * 取り出し元で解決できた import だけを書き直す（もともと解決できないものには手を付けない）。
 */
function rebindImports(
  src: ProjectSnapshot,
  dst: ProjectSnapshot,
  added: Map<string, string>,
  aliases: Map<string, string>,
): void {
  const srcIndex = ResourcePathIndex.fromSnapshot(src);
  const dstIndex = ResourcePathIndex.fromSnapshot(dst);
  for (const [from, to] of added) {
    const before = src.systems.find((s) => s.id === from);
    const after = dst.systems.find((s) => s.id === to);
    if (!before || !after?.code.includes("import")) continue;
    after.code = rewriteImports(after.code, (spelling) => {
      const pkg = parsePackageSpelling(spelling);
      if (pkg) {
        const alias = aliases.get(pkg.alias);
        return alias && alias !== pkg.alias ? `@${alias}/${pkg.path}` : null;
      }
      const r = srcIndex.resolve(spelling, from);
      if (!r.ok) return null;
      const target = added.get(r.id) ?? r.id;
      return dstIndex.spellingFor(target, to, spelling.startsWith("/") ? "absolute" : "relative");
    });
  }
}
