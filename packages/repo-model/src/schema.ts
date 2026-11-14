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

/**
 * 型の定義（ADR 0065）。名前を付けた型（`Card` など）を、`.d.ts` の形（`type` と `interface`）で書くリソース。
 * KokoState のフィールドの型から使う。中身（コード）は、System のスクリプトと同じく別に持つ。
 */
export interface TypeDef {
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

/** プレハブを編集する場所（ADR 0076）。here：その場、isolated：離れた空間 */
export type PrefabEditPlace = "here" | "isolated";

/**
 * プレハブ（ADR 0076）。Entity・KokoState・System のまとまりを、部品として登録したリソース。
 * 中の Entity は、アウトプットの Entity とは別に持つ（`ProjectSnapshot.prefabEntities`）。
 * アウトプットの中に、インスタンスとして置いて使う。プレハブだけをセッションに出すことはない。
 */
export interface PrefabDef {
  id: string;
  name: string;
  /**
   * いちばん上の Entity（プレハブの中の Entity の ID）。プレハブの中の Entity は、すべてこの下に入る。
   * インスタンスの Entity が、この Entity に当たる。
   */
  root: EntityId;
  /** プレハブの System。インスタンスを置いたアウトプットで動く。並び順が実行順 */
  systems: OutputSystem[];
  /** プレハブの中で付けた「維持」の印（Entity は、プレハブの中の ID） */
  keep: KeepMark[];
  /** 編集する場所。ないときは「その場」 */
  editIn?: PrefabEditPlace;
  /** 消した Entity の元の親。インスタンスの親が消えたとき、残っている祖先へたどる */
  deletedParents?: Record<EntityId, EntityId | null>;
}

/** インスタンスで変えた所。キーはルートからの ID（ルート自身は空文字） */
export interface PrefabEntityOverride {
  name?: string;
  /** 既存 KokoState のフィールドごとの上書き */
  states?: Record<KokoStateId, KokoStateValues>;
  /** インスタンスで付けた KokoState */
  addedStates?: Record<KokoStateId, KokoStateValues>;
  /** 展開した Entity の ID。null はインスタンスのルート */
  parent?: EntityId | null;
  order?: number;
}

/** インスタンスが持つ、プレハブとのつながり（ADR 0076） */
export interface PrefabInstanceLink {
  /** プレハブのリソース ID。名前を変えても動かしても切れない */
  prefab: string;
}

/** アウトプットの Entity と、プレハブの中の Entity に共通の形 */
export interface EntityBase {
  id: EntityId;
  name: string;
  parent: EntityId | null;
  /** 兄弟の中での並び順 */
  order: number;
  states: Record<KokoStateId, KokoStateValues>;
  /**
   * プレハブのインスタンスなら、そのプレハブ（ADR 0076）。使う所の手前で、プレハブの中身に展開する
   * （`expandPrefabs`）。場所・向き・大きさ（Transform）は、インスタンスそのものが持つ。
   */
  instanceOf?: PrefabInstanceLink;
  prefabOverrides?: Record<string, PrefabEntityOverride>;
  /** インスタンスで足した System */
  instanceSystems?: OutputSystem[];
}

export interface EntityDef extends EntityBase {
  output: string;
}

/** プレハブの中の Entity。アウトプットではなく、プレハブに属する */
export interface PrefabEntityDef extends EntityBase {
  /** 属するプレハブの ID */
  prefab: string;
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
  /** 型の定義（古いデータにはない） */
  types?: (TypeDef & { code: string })[];
  materials: MaterialDef[];
  /** 古いデータにはない */
  assets?: AssetDef[];
  outputs: OutputDef[];
  entities: EntityDef[];
  /** フォーク・抽出の由来（元のリポジトリやコミットを後から追える） */
  provenance?: Provenance[];
  /** Resources のフォルダ（古いデータにはない） */
  folders?: FolderDef[];
  /** リソース（KokoState・System・マテリアル・素材・プレハブ）の ID → 入っているフォルダの ID。ないものはいちばん上 */
  placement?: Record<string, string>;
  /** 使うライブラリ（別名の順。古いデータにはない。ADR 0015） */
  dependencies?: PackageDependency[];
  /** プレハブ（古いデータにはない。ADR 0076） */
  prefabs?: PrefabDef[];
  /** プレハブの中の Entity（古いデータにはない。ADR 0076） */
  prefabEntities?: PrefabEntityDef[];
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
