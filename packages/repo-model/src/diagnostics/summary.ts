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
