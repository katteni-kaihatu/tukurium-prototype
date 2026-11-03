import type { KokoStateDef } from "@tukurium/eks";
import { BUILTIN_KOKOSTATES } from "./builtins";
import type { ResourceKind } from "./diagnostics/types";
import { parseQuery } from "./queryInfo";
import type { ProjectSnapshot } from "./schema";

/**
 * 制作データの依存グラフ（計画 Phase 3）。「A は B に依存する」を A → B の辺で持つ。
 * 診断の調べ直し・使われている場所の表示・抽出で、同じ走査を共有するための土台。
 *
 * - Material → 画像の素材
 * - Entity → 持っている KokoState・指しているリソースや Entity・親の Entity
 * - Output → その System・その Entity
 * - System → Query に書いた KokoState の名前（`name:kokostate/<名前>`）
 *
 * System の Query は今は表示名で書くため、名前の節を介して KokoState の変更とつなぐ
 * （見つからない名前も節として持つので、その名前の KokoState を作ったときにも気付ける）。
 * Phase 4 で仮想 import の結び付け（安定 ID）に置き換える。
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

/** KokoState の名前の節 */
export const kokoNameRef = (name: string): GraphRef => ({ kind: "name", id: `kokostate/${name}` });

export class ProjectDependencyGraph {
  /** 依存先（A → B の B） */
  private readonly out = new Map<string, Set<string>>();
  /** 依存元（A → B の A） */
  private readonly in = new Map<string, Set<string>>();

  static fromSnapshot(snap: ProjectSnapshot): ProjectDependencyGraph {
    return new ProjectDependencyGraph(snap);
  }

  private constructor(snap: ProjectSnapshot) {
    const materials = new Set(snap.materials.map((m) => m.id));
    const defs = new Map<string, KokoStateDef>();
    for (const k of [...BUILTIN_KOKOSTATES, ...snap.kokostates]) defs.set(k.id, k);

    for (const m of snap.materials)
      if (m.map) this.edge({ kind: "material", id: m.id }, { kind: "asset", id: m.map });

    for (const e of snap.entities) {
      const from: GraphRef = { kind: "entity", id: e.id };
      if (e.parent) this.edge(from, { kind: "entity", id: e.parent });
      for (const [kokoId, values] of Object.entries(e.states)) {
        this.edge(from, { kind: "kokostate", id: kokoId });
        for (const f of defs.get(kokoId)?.fields ?? []) {
          const v = values[f.id];
          if (typeof v !== "string" || v === "") continue;
          if (f.type === "resource")
            this.edge(from, { kind: materials.has(v) ? "material" : "asset", id: v });
          else if (f.type === "entity") this.edge(from, { kind: "entity", id: v });
        }
      }
      this.edge({ kind: "output", id: e.output }, from);
    }

    for (const o of snap.outputs)
      for (const s of o.systems)
        this.edge({ kind: "output", id: o.id }, { kind: "system", id: s.id });

    for (const s of snap.systems) {
      const q = parseQuery(s.code);
      for (const name of [...q.with, ...q.without])
        this.edge({ kind: "system", id: s.id }, kokoNameRef(name));
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

/** 制作データのリソースを、ref ごとの中身（比べるための文字列）にする */
function resourceHashes(snap: ProjectSnapshot): Map<string, string> {
  const out = new Map<string, string>();
  const put = (kind: ResourceKind, id: string, v: unknown) =>
    out.set(refKey({ kind, id }), JSON.stringify(v));
  for (const k of snap.kokostates) put("kokostate", k.id, k);
  for (const s of snap.systems) put("system", s.id, s);
  for (const m of snap.materials) put("material", m.id, m);
  for (const a of snap.assets ?? []) put("asset", a.id, a);
  for (const o of snap.outputs) put("output", o.id, o);
  for (const e of snap.entities) put("entity", e.id, e);
  for (const f of snap.folders ?? []) put("folder", f.id, f);
  return out;
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
  const names = new Map<string, string>();
  for (const k of prev.kokostates) names.set(`prev:${k.id}`, k.name);
  for (const k of next.kokostates) names.set(`next:${k.id}`, k.name);
  for (const key of [...changed]) {
    const r = parseKey(key);
    if (r.kind !== "kokostate") continue;
    for (const side of ["prev", "next"]) {
      const name = names.get(`${side}:${r.id}`);
      if (name !== undefined) changed.add(refKey(kokoNameRef(name)));
    }
  }
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
