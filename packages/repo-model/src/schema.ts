import type { EntityId, FieldId, KokoStateDef, KokoStateId, KokoStateValues } from "@tukurium/eks";

export type OutputKind = "item" | "world";

/** 状態維持のマーク：アウトプットごと・フィールド単位（要件 §7） */
export interface KeepMark {
  entity: EntityId;
  koko: KokoStateId;
  field: FieldId;
}

export interface OutputSystem {
  id: string;
  enabled: boolean;
}

export interface OutputDef {
  id: string;
  name: string;
  kind: OutputKind;
  /** このアウトプットで動かす System。並び順が実行順。 */
  systems: OutputSystem[];
  keep: KeepMark[];
}

export interface SystemDef {
  id: string;
  name: string;
}

export interface MaterialDef {
  id: string;
  name: string;
  color: string;
  roughness: number;
  metalness: number;
  /** 画像の素材 ID（色のテクスチャ）。なければ null */
  map?: string | null;
}

export type AssetKind = "model" | "image" | "audio";

/** 取り込んだ素材。id はサーバーに置いた中身の SHA-256 */
export interface AssetDef {
  id: string;
  name: string;
  kind: AssetKind;
  contentType: string;
}

export interface EntityDef {
  id: EntityId;
  name: string;
  parent: EntityId | null;
  output: string;
  /** 兄弟の中での並び順 */
  order: number;
  states: Record<KokoStateId, KokoStateValues>;
}

/** リポジトリ（制作データ）の中身をそのまま JSON にしたもの。 */
/** Resources のフォルダ（並べ方だけの情報。実行には関わらない） */
export interface FolderDef {
  id: string;
  name: string;
  /** 親のフォルダ。null はいちばん上（プロジェクト） */
  parent: string | null;
}

export interface ProjectSnapshot {
  version: 1;
  name: string;
  kokostates: KokoStateDef[];
  systems: (SystemDef & { code: string })[];
  materials: MaterialDef[];
  /** 古いデータにはない */
  assets?: AssetDef[];
  outputs: OutputDef[];
  entities: EntityDef[];
  /** フォーク・抽出の由来（元のリポジトリやコミットを後から追える） */
  provenance?: Provenance[];
  /** Resources のフォルダ（古いデータにはない） */
  folders?: FolderDef[];
  /** リソース（KokoState・System・マテリアル・素材）の ID → 入っているフォルダの ID。ないものはいちばん上 */
  placement?: Record<string, string>;
}

export interface Provenance {
  kind: "fork" | "extract";
  repoId: string;
  repoName: string;
  commit: string;
  /** 抽出したもの（アウトプット・リソースの名前） */
  items: string[];
  at: string;
}

export function newId(prefix: string): string {
  const raw =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `${prefix}_${raw.slice(0, 12)}`;
}
