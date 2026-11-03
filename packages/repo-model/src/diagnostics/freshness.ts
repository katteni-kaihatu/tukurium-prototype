import type { Diagnostic } from "./types";

/**
 * 診断の新しさ（ADR 0010 §5、計画 §8.3）。
 * 編集した直後は、前の結果を消さずに stale として見せ、再検査で差し替える（印の点滅を避ける）。
 */
export type Freshness = "current" | "stale";

/** ある版の制作データ（または実行）を調べた結果 */
export interface ObservedDiagnostics {
  diagnostics: readonly Diagnostic[];
  /** 調べたときの制作データの版 */
  observedVersion: number;
}

export type DiagnosticView = Diagnostic & { freshness: Freshness };

/**
 * 非同期の検査の世代。始めるたびに世代が進み、最後に始めたものの結果だけを受け取る。
 * 古い検査の結果が後から届いても、新しい結果を上書きしない。
 */
export class GenerationGate {
  private latest = 0;
  begin(): number {
    this.latest += 1;
    return this.latest;
  }
  accepts(generation: number): boolean {
    return generation === this.latest;
  }
}

const rank = (v: DiagnosticView) =>
  (v.freshness === "current" ? 0 : 4) +
  (v.phase === "runtime" ? 0 : 2) +
  (v.severity === "error" ? 0 : 1);

/**
 * いくつかの結果を、表示用の一つの並びにする。同じ指紋は新しい版のものを残す。
 * 並びは current → stale、その中で実行 → 作っている途中、エラー → 注意。
 */
export function viewDiagnostics(
  sets: readonly ObservedDiagnostics[],
  currentVersion: number,
): DiagnosticView[] {
  const byPrint = new Map<string, { view: DiagnosticView; version: number }>();
  for (const set of sets) {
    const freshness: Freshness = set.observedVersion === currentVersion ? "current" : "stale";
    for (const d of set.diagnostics) {
      const seen = byPrint.get(d.fingerprint);
      if (!seen || seen.version < set.observedVersion)
        byPrint.set(d.fingerprint, { view: { ...d, freshness }, version: set.observedVersion });
    }
  }
  return [...byPrint.values()].map((x) => x.view).sort((a, b) => rank(a) - rank(b));
}

/** current のエラー・注意の件数と、stale の件数 */
export function countCurrent(views: readonly DiagnosticView[]): {
  errors: number;
  warnings: number;
  stale: number;
} {
  let errors = 0;
  let warnings = 0;
  let stale = 0;
  for (const v of views) {
    if (v.freshness === "stale") stale++;
    else if (v.severity === "error") errors++;
    else if (v.severity === "warning") warnings++;
  }
  return { errors, warnings, stale };
}
