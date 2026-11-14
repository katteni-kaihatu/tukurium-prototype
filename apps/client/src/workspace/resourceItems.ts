import {
  type GraphRef,
  isPackageResourceId,
  type ProjectDependencyGraph,
  type ProjectDoc,
  packageResourceId,
  usersOf,
} from "@tukurium/repo-model";

/** Resources に並ぶものの種類 */
export type ResKind =
  | "folder"
  | "koko"
  | "builtin"
  | "system"
  | "typedef"
  | "material"
  | "prefab"
  | "model"
  | "image"
  | "audio";

export interface ResItem {
  id: string;
  kind: ResKind;
  name: string;
  /** 入っているフォルダ（null はいちばん上。Built-in は BUILTIN_FOLDER） */
  parent: string | null;
  /** マテリアルの色（見本の玉に使う） */
  color?: string;
  /** ライブラリから来たものは、名前や置き場所を変えられない。 */
  readOnly?: boolean;
}

/** Built-in の KokoState をまとめて見せる、読み取り専用のフォルダ */
export const BUILTIN_FOLDER = "__builtin";

/** 種類ごとの表示名と色（デザインの配色） */
export const KIND_META: Record<ResKind, { label: string; bg: string; fg: string }> = {
  folder: { label: "Folder", bg: "#FFF1BF", fg: "#9A6B00" },
  koko: { label: "KokoState", bg: "#EEF3DF", fg: "#4E6B1F" },
  builtin: { label: "Built-in", bg: "#EEF3DF", fg: "#4E6B1F" },
  system: { label: "Script", bg: "#E3E7F6", fg: "#2F4A9C" },
  typedef: { label: "Types", bg: "#E6F1F4", fg: "#1F5E6B" },
  material: { label: "Material", bg: "#F4F1EA", fg: "#9A4A16" },
  prefab: { label: "Prefab", bg: "#E4EEFB", fg: "#1D5FA8" },
  model: { label: "Model", bg: "#E3E7F6", fg: "#2F4A9C" },
  image: { label: "Texture", bg: "#E5F3EC", fg: "#1F6B47" },
  audio: { label: "Audio", bg: "#F1E8F8", fg: "#6B3E9A" },
};

/** 制作データのリソースを、フォルダの中身として並べられる形にする */
export function resourceItems(project: ProjectDoc): ResItem[] {
  const items: ResItem[] = [];
  for (const f of project.folders())
    items.push({ id: f.id, kind: "folder", name: f.name, parent: f.parent });
  items.push({ id: BUILTIN_FOLDER, kind: "folder", name: "Built-in", parent: null });
  for (const d of project.registry().all()) {
    if (isPackageResourceId(d.id)) continue;
    if (d.builtin) items.push({ id: d.id, kind: "builtin", name: d.name, parent: BUILTIN_FOLDER });
    else items.push({ id: d.id, kind: "koko", name: d.name, parent: project.folderOf(d.id) });
  }
  for (const s of project.systems())
    items.push({ id: s.id, kind: "system", name: s.name, parent: project.folderOf(s.id) });
  for (const t of project.typeDefs())
    items.push({ id: t.id, kind: "typedef", name: t.name, parent: project.folderOf(t.id) });
  for (const m of project.materials())
    items.push({
      id: m.id,
      kind: "material",
      name: m.name,
      parent: project.folderOf(m.id),
      color: m.color,
    });
  for (const p of project.prefabs())
    items.push({ id: p.id, kind: "prefab", name: p.name, parent: project.folderOf(p.id) });
  const available = project.snapshotWithPackages().prefabs ?? [];
  for (const dep of project.dependencies()) {
    const prefabs = available.filter((p) => p.id.startsWith(packageResourceId(dep, "")));
    if (prefabs.length === 0) continue;
    const parent = `__package:${dep.alias}`;
    items.push({
      id: parent,
      kind: "folder",
      name: `@${dep.alias} · v${dep.version}`,
      parent: null,
      readOnly: true,
    });
    for (const p of prefabs)
      items.push({ id: p.id, kind: "prefab", name: p.name, parent, readOnly: true });
  }
  for (const a of project.assets())
    items.push({ id: a.id, kind: a.kind, name: a.name, parent: project.folderOf(a.id) });
  return items;
}

/** 中身の並び：フォルダが先、あとは名前順 */
export function sortItems(items: ResItem[]): ResItem[] {
  return [...items].sort(
    (a, b) =>
      Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name),
  );
}

/** Resources に並ぶものを、依存グラフの節にする（フォルダは節にならない） */
export function itemRef(item: ResItem): GraphRef | null {
  switch (item.kind) {
    case "folder":
      return null;
    case "koko":
    case "builtin":
      return { kind: "kokostate", id: item.id };
    case "system":
      return { kind: "system", id: item.id };
    case "typedef":
      return { kind: "typedef", id: item.id };
    case "material":
      return { kind: "material", id: item.id };
    case "prefab":
      return { kind: "prefab", id: item.id };
    case "image":
    case "model":
    case "audio":
      return { kind: "asset", id: item.id };
  }
}

/** item を直接使っているもの（依存グラフから） */
export function usersOfItem(graph: ProjectDependencyGraph, item: ResItem): GraphRef[] {
  const ref = itemRef(item);
  return ref ? usersOf(graph, ref) : [];
}

const USER_LABEL: [GraphRef["kind"], string][] = [
  ["entity", "Entity"],
  ["kokostate", "KokoState"],
  ["system", "System"],
  ["output", "アウトプット"],
  ["material", "マテリアル"],
  ["prefab", "プレハブ"],
];

/**
 * 「どこで使っているか」の短い説明（詳細表示の Usage）。使っているものを種類ごとに数える
 * （例：「Entity 3・System 1」）。フォルダは中の項目の数。
 */
export function usageOf(item: ResItem, all: ResItem[], users: readonly GraphRef[]): string {
  if (item.kind === "folder") return `${all.filter((x) => x.parent === item.id).length} 項目`;
  const parts = USER_LABEL.flatMap(([kind, label]) => {
    const n = users.filter((u) => u.kind === kind).length;
    return n > 0 ? [`${label} ${n}`] : [];
  });
  return parts.length > 0 ? parts.join("・") : "未使用";
}
