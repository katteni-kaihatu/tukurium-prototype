import {
  type FieldSchemas,
  type KokoStateDef,
  schemaOfField,
  stringifyValue,
  visitRefs,
} from "@tukurium/eks";
import { BUILTIN_KOKOSTATES } from "./builtins";
import type { ResourceKind } from "./diagnostics/types";
import { ResourcePathIndex } from "./resourcePath";
import type { EntityBase, ProjectSnapshot } from "./schema";
import { compileSystem } from "./systemCompiler";

/**
 * 制作データの依存グラフ（計画 Phase 3）。「A は B に依存する」を A → B の辺で持つ。
 * 診断の調べ直し・使われている場所の表示・抽出で、同じ走査を共有するための土台。
 *
 * - Material → 画像の素材
 * - Entity → 持っている KokoState・指しているリソースや Entity・親の Entity
 * - インスタンスの Entity → プレハブ（ADR 0076）
 * - プレハブ → その System・中の Entity が持っている KokoState や指しているリソース・中で使っているプレハブ
 * - Output → その System・その Entity
 * - System → import した KokoState（安定 ID）
 * - System → `@別名/...` で import したライブラリ（`name:package/<別名>`。ADR 0015）
 * - import を書いた System → パスの構造（`name:paths`）
 *
 * 名前で書いた Query はやめた（ADR 0058）ので、KokoState の名前の節は持たない。
 */

export interface GraphRef {
  kind: ResourceKind | "name";
  id: string;
}

export const refKey = (r: GraphRef): string => `${r.kind}:${r.id}`;

function parseKey(key: string): GraphRef {
  const at = key.indexOf(":");
  return { kind: key.slice(0, at) as GraphRef["kind"], id: key.slice(at + 1) };
}

/**
 * パスの構造（フォルダ・置き場所・名前）の節。import を書いた System はこれに依存する
 * （フォルダの移動や名前の変更で、同じ書き方の解決先が変わりうるため）。
 */
export const PATHS_REF: GraphRef = { kind: "name", id: "paths" };

/** 依存の別名の節（別名が指す Package・版を変えると、それを import した System に届く） */
export const packageAliasRef = (alias: string): GraphRef => ({
  kind: "name",
  id: `package/${alias}`,
});

export class ProjectDependencyGraph {
  /** 依存先（A → B の B） */
  private readonly out = new Map<string, Set<string>>();
  /** 依存元（A → B の A） */
  private readonly in = new Map<string, Set<string>>();

  /**
   * schemas：TypeScript で作ったフィールドのスキーマ（あれば、入れ子の中の参照までたどる）。
   * なくても、Tukurium が用意する型のフィールドはたどれる。
   */
  static fromSnapshot(snap: ProjectSnapshot, schemas?: FieldSchemas): ProjectDependencyGraph {
    return new ProjectDependencyGraph(snap, schemas);
  }

  private constructor(snap: ProjectSnapshot, schemas?: FieldSchemas) {
    const defs = new Map<string, KokoStateDef>();
    for (const k of [...BUILTIN_KOKOSTATES, ...snap.kokostates]) defs.set(k.id, k);

    for (const m of snap.materials)
      if (m.map) this.edge({ kind: "material", id: m.id }, { kind: "asset", id: m.map });

    // KokoState → フィールドの型で使う、型の定義（ADR 0065）
    for (const k of snap.kokostates)
      for (const id of k.typeDefs ?? [])
        this.edge({ kind: "kokostate", id: k.id }, { kind: "typedef", id });

    // 展開した Entity を指すときは、保存元のインスタンスに依存する。
    const entityOwner = (id: string) => id.split("/")[0] ?? id;
    const usesStates = (from: GraphRef, states: EntityBase["states"], inPrefab: boolean) => {
      for (const [kokoId, values] of Object.entries(states)) {
        this.edge(from, { kind: "kokostate", id: kokoId });
        for (const f of defs.get(kokoId)?.fields ?? []) {
          const schema = schemaOfField(schemas, kokoId, f);
          if (!schema) continue;
          visitRefs(schema, values[f.id], (target, id) => {
            if (target === "entity" && inPrefab) return;
            const kind = target === "entity" || target === "material" ? target : "asset";
            this.edge(from, { kind, id: target === "entity" ? entityOwner(id) : id });
          });
        }
      }
    };
    /** Entity と、インスタンスで足した値や System が使うもの。プレハブの中では Entity どうしの辺は持たない */
    const uses = (from: GraphRef, e: EntityBase, inPrefab: boolean) => {
      if (e.instanceOf) this.edge(from, { kind: "prefab", id: e.instanceOf.prefab });
      usesStates(from, e.states, inPrefab);
      for (const override of Object.values(e.prefabOverrides ?? {})) {
        usesStates(from, override.states ?? {}, inPrefab);
        usesStates(from, override.addedStates ?? {}, inPrefab);
        if (override.parent && !inPrefab)
          this.edge(from, { kind: "entity", id: entityOwner(override.parent) });
      }
      for (const system of [...(e.unpackedSystems ?? []), ...(e.instanceSystems ?? [])])
        this.edge(from, { kind: "system", id: system.id });
    };

    for (const e of snap.entities) {
      const from: GraphRef = { kind: "entity", id: e.id };
      if (e.parent) this.edge(from, { kind: "entity", id: entityOwner(e.parent) });
      uses(from, e, false);
      this.edge({ kind: "output", id: e.output }, from);
    }

    // プレハブ（ADR 0076）。中の Entity が使うものは、プレハブが使うものとして持つ
    for (const p of snap.prefabs ?? [])
      for (const s of p.systems)
        this.edge({ kind: "prefab", id: p.id }, { kind: "system", id: s.id });
    for (const e of snap.prefabEntities ?? []) uses({ kind: "prefab", id: e.prefab }, e, true);

    for (const o of snap.outputs)
      for (const s of o.systems)
        this.edge({ kind: "output", id: o.id }, { kind: "system", id: s.id });

    let index: ResourcePathIndex | null = null;
    for (const s of snap.systems) {
      const from: GraphRef = { kind: "system", id: s.id };
      // import で書いた KokoState（ADR 0010）
      if (!s.code.includes("import")) continue;
      index ??= ResourcePathIndex.fromSnapshot(snap);
      const compiled = compileSystem(s.id, s.code, index);
      if (compiled.bindings.length === 0 && compiled.diagnostics.length === 0) continue;
      this.edge(from, PATHS_REF);
      for (const alias of compiled.packageImports) this.edge(from, packageAliasRef(alias));
      for (const b of compiled.bindings) this.edge(from, { kind: "kokostate", id: b.resourceId });
    }
  }

  private edge(from: GraphRef, to: GraphRef): void {
    const a = refKey(from);
    const b = refKey(to);
    const o = this.out.get(a) ?? new Set<string>();
    o.add(b);
    this.out.set(a, o);
    const i = this.in.get(b) ?? new Set<string>();
    i.add(a);
    this.in.set(b, i);
  }

  /** ref が直接依存しているもの */
  dependenciesOf(ref: GraphRef): GraphRef[] {
    return [...(this.out.get(refKey(ref)) ?? [])].map(parseKey);
  }

  /** ref に直接依存しているもの */
  dependentsOf(ref: GraphRef): GraphRef[] {
    return [...(this.in.get(refKey(ref)) ?? [])].map(parseKey);
  }

  /** refs と、それに（間接的にでも）依存しているもの全部 */
  transitiveDependents(refs: Iterable<GraphRef>): GraphRef[] {
    const seen = new Set<string>();
    const stack = [...refs].map(refKey);
    while (stack.length > 0) {
      const k = stack.pop() as string;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const d of this.in.get(k) ?? []) if (!seen.has(d)) stack.push(d);
    }
    return [...seen].map(parseKey);
  }
}

/**
 * ref を直接使っているもの（Entity・System・アウトプット・マテリアル）。「どこで使っているか」の表示に使う。
 * 同じものは一度だけ返す。
 */
export function usersOf(graph: ProjectDependencyGraph, ref: GraphRef): GraphRef[] {
  const seen = new Set<string>();
  const out: GraphRef[] = [];
  for (const u of graph.dependentsOf(ref)) {
    if (u.kind === "name") continue;
    const k = refKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

/** 制作データのリソースを、ref ごとの中身（比べるための文字列）にする */
function resourceHashes(snap: ProjectSnapshot): Map<string, string> {
  const out = new Map<string, string>();
  const put = (kind: ResourceKind, id: string, v: unknown) =>
    out.set(refKey({ kind, id }), stringifyValue(v));
  for (const k of snap.kokostates) put("kokostate", k.id, k);
  for (const s of snap.systems) put("system", s.id, s);
  for (const t of snap.types ?? []) put("typedef", t.id, t);
  for (const m of snap.materials) put("material", m.id, m);
  for (const a of snap.assets ?? []) put("asset", a.id, a);
  for (const o of snap.outputs) put("output", o.id, o);
  for (const e of snap.entities) put("entity", e.id, e);
  for (const f of snap.folders ?? []) put("folder", f.id, f);
  // プレハブは、中の Entity も合わせて一つのリソースとして比べる
  for (const p of snap.prefabs ?? [])
    put("prefab", p.id, [p, (snap.prefabEntities ?? []).filter((e) => e.prefab === p.id)]);
  return out;
}

/** パスの構造を比べるための文字列（ID・名前・親・拡張子） */
function pathSignature(snap: ProjectSnapshot): string {
  return JSON.stringify(
    ResourcePathIndex.fromSnapshot(snap)
      .all()
      .map((e) => [e.id, e.name, e.parent, e.ext])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

/**
 * 前と今の制作データで、変わった（足された・消えた）リソース。
 * KokoState が変わったときは、前と今の名前の節も含める（名前で書いた Query のため）。
 */
export function changedRefs(prev: ProjectSnapshot, next: ProjectSnapshot): GraphRef[] {
  const a = resourceHashes(prev);
  const b = resourceHashes(next);
  const changed = new Set<string>();
  for (const [k, v] of a) if (b.get(k) !== v) changed.add(k);
  for (const k of b.keys()) if (!a.has(k)) changed.add(k);
  if (pathSignature(prev) !== pathSignature(next)) changed.add(refKey(PATHS_REF));
  const deps = (snap: ProjectSnapshot) =>
    new Map((snap.dependencies ?? []).map((d) => [d.alias, JSON.stringify(d)] as const));
  const [depsA, depsB] = [deps(prev), deps(next)];
  for (const alias of new Set([...depsA.keys(), ...depsB.keys()]))
    if (depsA.get(alias) !== depsB.get(alias)) changed.add(refKey(packageAliasRef(alias)));
  return [...changed].map(parseKey);
}

/**
 * 調べ直しが要るもの：変わったものと、前・今のどちらかのグラフでそれに依存しているもの。
 * （消えた辺もたどるため、前のグラフも見る）
 */
export function dirtyRefs(prev: ProjectSnapshot, next: ProjectSnapshot): GraphRef[] {
  const changed = changedRefs(prev, next);
  if (changed.length === 0) return [];
  const seen = new Map<string, GraphRef>();
  for (const snap of [prev, next])
    for (const r of ProjectDependencyGraph.fromSnapshot(snap).transitiveDependents(changed))
      seen.set(refKey(r), r);
  return [...seen.values()];
}
