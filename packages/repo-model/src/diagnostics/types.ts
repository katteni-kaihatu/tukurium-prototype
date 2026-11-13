/**
 * 汎用の診断（ADR 0010 §5）。「今の制作データ、または直前の実行に残っている問題」を表す。
 * 診断は保存しない（Y.Doc・ProjectSnapshot・Git に入れない）。
 */

export type ResourceKind =
  | "project"
  | "folder"
  | "output"
  | "entity"
  | "kokostate"
  | "system"
  | "typedef"
  | "material"
  | "asset";

export interface ResourceRef {
  kind: ResourceKind;
  id: string;
}

/** プロジェクト全体を指すときの対象 */
export const PROJECT_REF: ResourceRef = { kind: "project", id: "project" };

/** 問題の場所。行番号などの動きやすい値は指紋に入れない */
export type DiagnosticLocation =
  | { kind: "name" }
  /** symbol：どの書き方についての問題か（Query の名前など。指紋に入る） */
  | { kind: "script"; line: number | null; column?: number; symbol?: string }
  | { kind: "property"; path: string[] };

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  /** 指紋と同じ（同じ問題なら同じ ID） */
  id: string;
  fingerprint: string;
  code: string;
  severity: Severity;
  /** authoring：作っている途中の問題、runtime：実行して起きた問題 */
  phase: "authoring" | "runtime";
  /** 診断の担い手（structure・references・script など） */
  provider: string;
  /** 直すべきリソース */
  subject: ResourceRef;
  location: DiagnosticLocation | null;
  /** 原因・参照先・影響先 */
  related: ResourceRef[];
  message: string;
  detail?: string;
  /** まとめた回数（dedupeDiagnostics が数える） */
  count?: number;
}

export type DiagnosticInput = Omit<Diagnostic, "id" | "fingerprint" | "count">;

const refKey = (r: ResourceRef) => `${r.kind}:${r.id}`;

function stableLocation(loc: DiagnosticLocation | null): string {
  if (!loc) return "";
  switch (loc.kind) {
    case "name":
      return "name";
    case "script":
      // 前の行に書き足しただけで別の問題にならないよう、行番号は使わない
      return loc.symbol === undefined ? "script" : `script:${loc.symbol}`;
    case "property":
      return `property:${loc.path.join(".")}`;
  }
}

/** provider・code・対象・安定した位置・関係するリソースから指紋を作る */
export function fingerprintOf(d: DiagnosticInput): string {
  return [
    d.provider,
    d.code,
    refKey(d.subject),
    stableLocation(d.location),
    d.related.map(refKey).sort().join(","),
  ].join("|");
}

export function makeDiagnostic(input: DiagnosticInput): Diagnostic {
  const fingerprint = fingerprintOf(input);
  return { ...input, id: fingerprint, fingerprint };
}

/** 同じ指紋の診断を一つにまとめる（最初のものを残し、回数を数える） */
export function dedupeDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const out = new Map<string, Diagnostic>();
  for (const d of list) {
    const seen = out.get(d.fingerprint);
    if (seen) seen.count = (seen.count ?? 1) + (d.count ?? 1);
    else out.set(d.fingerprint, { ...d, count: d.count ?? 1 });
  }
  return [...out.values()];
}
