import type { ResourcePathIndex } from "../resourcePath";
import type { Diagnostic } from "./types";

/** 一つのリソース・フォルダについての問題の件数 */
export interface DiagnosticSummary {
  /** 自分が直すべき問題 */
  errors: number;
  warnings: number;
  /** 中（フォルダの子孫）にある問題と、関係するものとして名前が挙がっている問題 */
  nestedErrors: number;
  nestedWarnings: number;
}

const empty = (): DiagnosticSummary => ({
  errors: 0,
  warnings: 0,
  nestedErrors: 0,
  nestedWarnings: 0,
});

/**
 * 問題をリソースごとに数える。自分の問題は祖先のフォルダの「中」にも数える。
 * 関係するもの（related）は、そのもの自身の「中」にだけ数え、祖先へは広げない。
 * info は数えない。
 */
export function summarizeDiagnostics(
  diagnostics: readonly Diagnostic[],
  index: ResourcePathIndex,
): Map<string, DiagnosticSummary> {
  const out = new Map<string, DiagnosticSummary>();
  const at = (id: string) => {
    let s = out.get(id);
    if (!s) {
      s = empty();
      out.set(id, s);
    }
    return s;
  };
  for (const d of diagnostics) {
    if (d.severity === "info") continue;
    const err = d.severity === "error";
    if (d.subject.kind !== "project") {
      const own = at(d.subject.id);
      if (err) own.errors++;
      else own.warnings++;
      const seen = new Set<string>([d.subject.id]);
      for (
        let p = index.entry(d.subject.id)?.parent ?? null;
        p && !seen.has(p);
        p = index.entry(p)?.parent ?? null
      ) {
        seen.add(p);
        const s = at(p);
        if (err) s.nestedErrors++;
        else s.nestedWarnings++;
      }
    }
    for (const r of d.related) {
      if (r.id === d.subject.id) continue;
      const s = at(r.id);
      if (err) s.nestedErrors++;
      else s.nestedWarnings++;
    }
  }
  return out;
}

/**
 * Hierarchy の印に使う件数（計画 §8.6）。Entity の問題は、その Entity 自身に数え、
 * 親の Entity とアウトプットの「中」にも数える。System の問題は、その System を
 * 使っているアウトプットの「中」に数える。アウトプット自身の問題は、アウトプットに数える。
 * 戻り値のキーは Entity の ID かアウトプットの ID。info は数えない。
 */
export function summarizeHierarchy(
  diagnostics: readonly Diagnostic[],
  entities: readonly { id: string; parent: string | null; output: string }[],
  outputs: readonly { id: string; systems: readonly { id: string }[] }[],
): Map<string, DiagnosticSummary> {
  const out = new Map<string, DiagnosticSummary>();
  const at = (id: string) => {
    let s = out.get(id);
    if (!s) {
      s = empty();
      out.set(id, s);
    }
    return s;
  };
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const d of diagnostics) {
    if (d.severity === "info") continue;
    const err = d.severity === "error";
    const own = (id: string) => {
      const s = at(id);
      if (err) s.errors++;
      else s.warnings++;
    };
    const nested = (id: string) => {
      const s = at(id);
      if (err) s.nestedErrors++;
      else s.nestedWarnings++;
    };
    const { kind, id } = d.subject;
    if (kind === "entity") {
      const e = byId.get(id);
      if (!e) continue;
      own(id);
      const seen = new Set<string>([id]);
      for (let p = e.parent; p && !seen.has(p); p = byId.get(p)?.parent ?? null) {
        seen.add(p);
        nested(p);
      }
      nested(e.output);
    } else if (kind === "output") {
      own(id);
    } else if (kind === "system") {
      for (const o of outputs) if (o.systems.some((s) => s.id === id)) nested(o.id);
    }
  }
  return out;
}
