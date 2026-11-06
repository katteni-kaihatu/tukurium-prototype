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
  /** 参照先 Entity。未設定は null。 */
  entity: EntityId | null;
  /** 素材などのリソース ID。未設定は null。 */
  resource: string | null;
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

/** KokoState の値。キーはフィールド ID。 */
export type KokoStateValues = Record<FieldId, FieldValue>;

export interface Query {
  with: KokoStateId[];
  without?: KokoStateId[];
}
