import type { KokoStateDef } from "@tukurium/eks";
import { KOKO_ROLES } from "@tukurium/repo-model";

/**
 * KokoState を選ぶ画面の中身：検索と、件数付きのタグでの絞り込み。
 * タグは「出どころ」と「役割」の 2 つの組に分ける。同じ組の中で選んだタグはどれかに合えばよく、
 * 組をまたぐと両方に合うものだけを出す。件数は、検索ともう一方の組の選択を当てたあとの数。
 */

export type TagGroup = "source" | "role";

export interface CatalogTag {
  /** `source:builtin`・`source:pkg:<別名>`・`role:physics`・`role:none` など */
  id: string;
  group: TagGroup;
  label: string;
  count: number;
}

export interface CatalogEntry {
  def: KokoStateDef;
  /** 依存のライブラリの KokoState なら、その別名 */
  alias: string | null;
  source: string;
  role: string;
}

const NO_ROLE = "role:none";
const ROLE_LABEL = new Map<string, string>(KOKO_ROLES.map((r) => [`role:${r.id}`, r.label]));

export function catalogEntries(
  defs: KokoStateDef[],
  aliasOf: (d: KokoStateDef) => string | null,
): CatalogEntry[] {
  return defs.map((def) => {
    const alias = aliasOf(def);
    const role = def.role && ROLE_LABEL.has(`role:${def.role}`) ? `role:${def.role}` : NO_ROLE;
    const source = def.builtin
      ? "source:builtin"
      : alias
        ? `source:pkg:${alias}`
        : "source:project";
    return { def, alias, source, role };
  });
}

const matchesQuery = (e: CatalogEntry, q: string) => {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return (
    e.def.name.toLowerCase().includes(t) ||
    e.def.fields.some((f) => f.name.toLowerCase().includes(t)) ||
    (e.alias?.toLowerCase().includes(t) ?? false)
  );
};

const groupOf = (tag: string): TagGroup => (tag.startsWith("source:") ? "source" : "role");

/** 一つの組の選択に合うか（その組で何も選んでいなければ合う） */
const matchesGroup = (e: CatalogEntry, group: TagGroup, selected: ReadonlySet<string>) => {
  const inGroup = [...selected].filter((t) => groupOf(t) === group);
  if (inGroup.length === 0) return true;
  return inGroup.includes(group === "source" ? e.source : e.role);
};

export function filterCatalog(
  entries: CatalogEntry[],
  q: string,
  selected: ReadonlySet<string>,
): CatalogEntry[] {
  return entries
    .filter(
      (e) =>
        matchesQuery(e, q) &&
        matchesGroup(e, "source", selected) &&
        matchesGroup(e, "role", selected),
    )
    .sort(
      (a, b) =>
        sourceOrder(a.source) - sourceOrder(b.source) || a.def.name.localeCompare(b.def.name),
    );
}

/** 並びは「このプロジェクト」→ ライブラリ → Built-in（自分で作ったものを先に） */
function sourceOrder(source: string): number {
  if (source === "source:project") return 0;
  if (source === "source:builtin") return 2;
  return 1;
}

function sourceLabel(source: string): string {
  if (source === "source:builtin") return "Built-in";
  if (source === "source:project") return "このプロジェクト";
  return `@${source.slice("source:pkg:".length)}`;
}

/** タグと件数。どの KokoState にも当てはまらないタグは出さない（選んでいるものは 0 件でも出す） */
export function catalogTags(
  entries: CatalogEntry[],
  q: string,
  selected: ReadonlySet<string>,
): CatalogTag[] {
  const hit = entries.filter((e) => matchesQuery(e, q));
  const tags: CatalogTag[] = [];
  const add = (id: string, group: TagGroup, label: string) => {
    const other: TagGroup = group === "source" ? "role" : "source";
    const count = hit.filter(
      (e) => (group === "source" ? e.source : e.role) === id && matchesGroup(e, other, selected),
    ).length;
    const exists = entries.some((e) => (group === "source" ? e.source : e.role) === id);
    if (exists || selected.has(id)) tags.push({ id, group, label, count });
  };
  const sources = [...new Set(entries.map((e) => e.source))].sort(
    (a, b) => sourceOrder(a) - sourceOrder(b) || a.localeCompare(b),
  );
  for (const s of sources) add(s, "source", sourceLabel(s));
  for (const r of KOKO_ROLES) add(`role:${r.id}`, "role", r.label);
  add(NO_ROLE, "role", "役割なし");
  return tags;
}

export function roleLabel(role: string): string | null {
  return ROLE_LABEL.get(role) ?? null;
}
