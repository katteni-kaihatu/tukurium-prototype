import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import {
  BUILTIN_KOKOSTATES,
  type PackageResolution,
  type ProjectSnapshot,
  ResourcePathIndex,
} from "@tukurium/repo-model";

/** import できる KokoState ひとつ */
export interface ImportCandidate {
  /** リソースの名前（import のローカル名にそのまま使う） */
  name: string;
  /** `from` に書くパス */
  spelling: string;
  /** どこのものか（このプロジェクト・Built-in・@別名） */
  source: string;
}

/**
 * このスクリプトから import できるもの（KokoState・プレハブ・マテリアル・素材）。
 * プロジェクトのものはスクリプトの場所からの相対パス、Built-in は `@builtin/`、ライブラリは `@別名/`。
 */
export function importCandidates(
  snap: ProjectSnapshot,
  systemId: string,
  packages: ReadonlyMap<string, PackageResolution>,
): ImportCandidate[] {
  const index = ResourcePathIndex.fromSnapshot(snap);
  const out: ImportCandidate[] = [];
  for (const k of snap.kokostates) {
    if (k.builtin) continue;
    const spelling =
      index.spellingFor(k.id, systemId, "relative") ??
      index.spellingFor(k.id, systemId, "absolute");
    if (spelling) out.push({ name: k.name, spelling, source: "このプロジェクト" });
  }
  // プレハブ・マテリアル・素材（ADR 0082）
  for (const r of [...(snap.prefabs ?? []), ...snap.materials, ...(snap.assets ?? [])]) {
    const spelling =
      index.spellingFor(r.id, systemId, "relative") ??
      index.spellingFor(r.id, systemId, "absolute");
    if (spelling) out.push({ name: r.name, spelling, source: "このプロジェクト" });
  }
  for (const b of BUILTIN_KOKOSTATES) {
    out.push({ name: b.name, spelling: `@builtin/${b.name}.koko`, source: "Built-in" });
  }
  for (const [alias, r] of packages) {
    if (r.status !== "ready") continue;
    for (const e of r.manifest.exports) {
      const def = e.definition as { name?: unknown } | null;
      if (
        !["kokostate", "prefab", "material", "asset"].includes(e.kind) ||
        typeof def?.name !== "string"
      )
        continue;
      out.push({
        name: def.name,
        spelling: `@${alias}/${e.path.replace(/^\/+/, "")}`,
        source: `@${alias}`,
      });
    }
  }
  return out;
}

/** import のパス文字列だけを補完する。名前と本文の候補は TypeScript に任せる。 */
export function importCompletionSource(candidates: () => ImportCandidate[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const node = syntaxTree(context.state).resolveInner(context.pos, -1);

    // from "…" の中
    const path = context.matchBefore(/\bfrom\s+["'][^"'\n]*$/);
    if (path && node.name === "String") {
      const quote = path.text.search(/["']/);
      const list = candidates();
      if (list.length === 0) return null;
      return {
        from: path.from + quote + 1,
        options: list.map((c) => ({
          label: c.spelling,
          detail: c.name,
          info: `${c.source}の KokoState`,
          type: "text",
        })),
        validFor: /^[^"'\n]*$/,
      };
    }
    return null;
  };
}
