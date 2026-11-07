import type { EntityId, FieldId, KokoStateDef, KokoStateId, KokoStateValues } from "@tukurium/eks";

export type OutputKind = "item" | "world" | "library";

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
  /**
   * 別の配置（別の作者の Item / World）からの見え方（ADR 0012）。ないときは interactive。
   * - private：Raycast も当たらない（見つからない）
   * - collision：Raycast は当たるが、Contract は受け付けない
   * - interactive：公開した Contract（System の contracts）を受け付ける
   */
  exposure?: OutputExposure;
  /**
   * World のときだけ：外から来た Item（別の作者の Item）に許すこと（ADR 0012）。ないときは interactive。
   * セッションでは、最初に置いた World が土台になり、その上限がほかの作者の Item にかかる。
   * - deny：自分の配置の外は見つからない
   * - collision：Raycast と一時的な effect まで。Contract は送れない
   * - interactive：相手が公開した Contract も送れる
   */
  guestPolicy?: GuestPolicy;
  /**
   * サムネイル：Resources にある画像の素材 ID（ADR 0046）。アイテム・マーケットのカードや
   * プロジェクトの一覧に出す。ないときは名前の文字を出す。
   */
  thumbnail?: string;
  /**
   * ライブラリのときだけ：含めるリソースの ID（KokoState・System・マテリアル・素材。ADR 0015・0055）。
   * 含めたものだけが Package に入り、使う側から import できる。ライブラリは Entity を持たない。
   */
  resources?: string[];
}

export type GuestPolicy = "deny" | "collision" | "interactive";

export type OutputExposure = "private" | "collision" | "interactive";

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
  /** 使うライブラリ（別名の順。古いデータにはない。ADR 0015） */
  dependencies?: PackageDependency[];
}

/**
 * プロジェクトが使うライブラリ（ADR 0015）。版と content hash を固定（lock）し、
 * 自動で新しい版へは切り替えない。
 */
export interface PackageDependency {
  /** import で書く別名（`@別名/States/Health.koko`） */
  alias: string;
  /** Package ID（ライブラリの作品の ID） */
  packageId: string;
  /** リリースの番号 */
  version: number;
  /** その版の content hash（取り出した中身がこれと違えば使わない） */
  contentHash: string;
}

export interface Provenance {
  kind: "fork" | "extract";
  repoId: string;
  repoName: string;
  commit: string;
  /** 抽出したもの（アウトプット・リソースの名前） */
  items: string[];
  /** 抽出したリソースの、取り出し元での論理パス（ADR 0010。アウトプットはパスを持たないので入らない） */
  paths?: string[];
  /** 抽出と一緒に持ってきた依存（取り込み先での別名。ADR 0015） */
  dependencies?: PackageDependency[];
  at: string;
}

export function newId(prefix: string): string {
  const raw =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `${prefix}_${raw.slice(0, 12)}`;
}
