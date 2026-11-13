/** Entity の識別子。リポジトリ内で安定した ID（作成時に発行）。 */
export type EntityId = string;
/** KokoState 定義の識別子。名前変更しても変わらない。 */
export type KokoStateId = string;
/** フィールドの識別子。名前変更しても変わらない（状態維持の照合に使う）。 */
export type FieldId = string;

export type Vec3 = [number, number, number];

/** フィールドの型と値の対応。 */
export interface FieldValueMap {
  number: number;
  boolean: boolean;
  string: string;
  vec3: Vec3;
  /** "#rrggbb" */
  color: string;
  /** 参照先 Entity。「なし」は undefined（null は使わない。ADR 0065）。 */
  entity: EntityId | undefined;
  /** テクスチャ（画像の素材）の ID。「なし」は undefined。 */
  texture: string | undefined;
  /** マテリアルの ID。「なし」は undefined。 */
  material: string | undefined;
  /** モデル（3D の素材）の ID。「なし」は undefined。 */
  model: string | undefined;
  /** 音声の素材の ID。「なし」は undefined。 */
  audio: string | undefined;
}

/** リソースを指す欄の型（テクスチャ・マテリアル・モデル・音声） */
export type ResourceFieldType = "texture" | "material" | "model" | "audio";

export const RESOURCE_FIELD_TYPES: readonly ResourceFieldType[] = [
  "texture",
  "material",
  "model",
  "audio",
];

export function isResourceFieldType(type: string): type is ResourceFieldType {
  return (RESOURCE_FIELD_TYPES as readonly string[]).includes(type);
}

export type FieldType = keyof FieldValueMap;
export type FieldValue = FieldValueMap[FieldType];

export interface FieldDef<T extends FieldType = FieldType> {
  id: FieldId;
  name: string;
  type: T;
  default: FieldValueMap[T];
}

export interface KokoStateDef {
  id: KokoStateId;
  name: string;
  /** フィールドなしの KokoState はタグとして Query の絞り込みに使う。 */
  fields: FieldDef[];
  builtin?: boolean;
  /** 役割（配置・見た目・物理など。`KOKO_ROLES` の ID）。選ぶ画面の絞り込みに使い、実行には関わらない */
  role?: string;
}

/**
 * KokoState の値。キーはフィールド ID。
 * 値が undefined のフィールド（参照の「なし」など）と、キーがないフィールドは別のもの。
 * あるかどうかは `in` で確かめる。
 */
export type KokoStateValues = Record<FieldId, FieldValue>;

export interface Query {
  with: KokoStateId[];
  without?: KokoStateId[];
}
