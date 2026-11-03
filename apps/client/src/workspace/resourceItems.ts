import { BUILTIN, type ProjectDoc } from "@tukurium/repo-model";

/** Resources に並ぶものの種類 */
export type ResKind =
  | "folder"
  | "koko"
  | "builtin"
  | "system"
  | "material"
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
}

/** Built-in の KokoState をまとめて見せる、読み取り専用のフォルダ */
export const BUILTIN_FOLDER = "__builtin";

/** 種類ごとの表示名と色（デザインの配色） */
export const KIND_META: Record<ResKind, { label: string; bg: string; fg: string }> = {
  folder: { label: "Folder", bg: "#FFF1BF", fg: "#9A6B00" },
  koko: { label: "KokoState", bg: "#EEF3DF", fg: "#4E6B1F" },
  builtin: { label: "Built-in", bg: "#EEF3DF", fg: "#4E6B1F" },
  system: { label: "Script", bg: "#E3E7F6", fg: "#2F4A9C" },
  material: { label: "Material", bg: "#F4F1EA", fg: "#9A4A16" },
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
    if (d.builtin) items.push({ id: d.id, kind: "builtin", name: d.name, parent: BUILTIN_FOLDER });
    else items.push({ id: d.id, kind: "koko", name: d.name, parent: project.folderOf(d.id) });
  }
  for (const s of project.systems())
    items.push({ id: s.id, kind: "system", name: s.name, parent: project.folderOf(s.id) });
  for (const m of project.materials())
    items.push({
      id: m.id,
      kind: "material",
      name: m.name,
      parent: project.folderOf(m.id),
      color: m.color,
    });
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

/** 「どこで使っているか」の短い説明（詳細表示の Usage） */
export function usageOf(project: ProjectDoc, item: ResItem, all: ResItem[]): string {
  const entities = project.entities();
  const count = (n: number, unit: string, none = "未使用") => (n > 0 ? `${unit} ${n}` : none);
  switch (item.kind) {
    case "folder":
      return `${all.filter((x) => x.parent === item.id).length} 項目`;
    case "koko":
    case "builtin":
      return count(
        entities.filter((e) => item.id in e.states).length,
        "Entity",
        "誰も持っていない",
      );
    case "system":
      return count(
        project.outputs().filter((o) => o.systems.some((s) => s.id === item.id && s.enabled))
          .length,
        "アウトプット",
        "どこでも有効でない",
      );
    case "material":
      return count(
        entities.filter((e) => e.states[BUILTIN.Mesh]?.material === item.id).length,
        "使用中",
      );
    case "model":
      return count(
        entities.filter((e) => e.states[BUILTIN.Mesh]?.model === item.id).length,
        "使用中",
      );
    case "image":
      return count(project.materials().filter((m) => m.map === item.id).length, "マテリアル");
    case "audio":
      return count(
        entities.filter((e) => e.states[BUILTIN.AudioSource]?.clip === item.id).length,
        "使用中",
      );
  }
}
