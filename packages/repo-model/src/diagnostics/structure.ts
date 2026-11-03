import { type NameProblem, type PathKind, ResourcePathIndex, validateName } from "../resourcePath";
import type { ProjectSnapshot } from "../schema";
import { type Diagnostic, makeDiagnostic, PROJECT_REF, type ResourceRef } from "./types";

/** 構造の検査（ADR 0010）：名前・フォルダ・置き場所 */
export const STRUCTURE_PROVIDER = "structure";

const NAME_REASON: Record<NameProblem, string> = {
  empty: "空の名前",
  slash: "「/」を含む名前",
  nul: "使えない文字を含む名前",
  dot: "「.」「..」",
  reserved: "「@builtin」で始まる名前",
};

const KIND_LABEL: Record<PathKind, string> = {
  folder: "フォルダ",
  kokostate: "KokoState",
  system: "Script",
  material: "Material",
  asset: "素材",
};

const ref = (kind: PathKind, id: string): ResourceRef => ({ kind, id });

export function checkProjectStructure(
  snap: ProjectSnapshot,
  index: ResourcePathIndex = ResourcePathIndex.fromSnapshot(snap),
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const base = {
    phase: "authoring" as const,
    provider: STRUCTURE_PROVIDER,
  };

  for (const e of index.all()) {
    const problem = validateName(e.name);
    if (problem)
      out.push(
        makeDiagnostic({
          ...base,
          code: "name-invalid",
          severity: "error",
          subject: ref(e.kind, e.id),
          location: { kind: "name" },
          related: [],
          message: `${KIND_LABEL[e.kind]}「${e.name}」の名前は使えません（${NAME_REASON[problem]}）`,
        }),
      );
  }

  for (const c of index.collisions()) {
    const entries = c.ids.map((id) => index.entry(id)).filter((e) => e !== undefined);
    const name = entries[0]?.name ?? c.key;
    out.push(
      makeDiagnostic({
        ...base,
        code: "name-collision",
        severity: "error",
        subject: c.parent === null ? PROJECT_REF : ref("folder", c.parent),
        location: null,
        related: entries.map((e) => ref(e.kind, e.id)),
        message: `同じ場所に「${name}」という名前が ${entries.length} つあります`,
        detail:
          "同じフォルダの中では、種類が違っても名前を一つにします（大文字・小文字の違いは同じとみなします）",
      }),
    );
  }

  for (const cycle of index.cycles()) {
    const [first, ...rest] = cycle;
    if (first === undefined) continue;
    out.push(
      makeDiagnostic({
        ...base,
        code: "folder-cycle",
        severity: "error",
        subject: ref("folder", first),
        location: null,
        related: rest.map((id) => ref("folder", id)),
        message: `フォルダ「${cycle.map((id) => index.entry(id)?.name ?? id).join("」「")}」が互いの中に入っています`,
      }),
    );
  }

  const folderIds = new Set((snap.folders ?? []).map((f) => f.id));
  for (const f of snap.folders ?? [])
    if (f.parent !== null && !folderIds.has(f.parent))
      out.push(
        makeDiagnostic({
          ...base,
          code: "folder-parent-missing",
          severity: "warning",
          subject: ref("folder", f.id),
          location: null,
          related: [],
          message: `フォルダ「${f.name}」の親のフォルダがありません（いちばん上にあるものとして扱います）`,
        }),
      );
  for (const [id, folder] of Object.entries(snap.placement ?? {})) {
    const e = index.entry(id);
    if (e && e.kind !== "folder" && !folderIds.has(folder))
      out.push(
        makeDiagnostic({
          ...base,
          code: "placement-missing-folder",
          severity: "warning",
          subject: ref(e.kind, e.id),
          location: null,
          related: [],
          message: `${KIND_LABEL[e.kind]}「${e.name}」の入っているフォルダがありません（いちばん上にあるものとして扱います）`,
        }),
      );
  }
  return out;
}
