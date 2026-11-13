import type { Value } from "./value";

/** Entity の識別子。リポジトリ内で安定した ID（作成時に発行）。 */
export type EntityId = string;
/** KokoState 定義の識別子。名前変更しても変わらない。 */
export type KokoStateId = string;
/** フィールドの識別子。名前変更しても変わらない（状態維持の照合に使う）。 */
export type FieldId = string;

export type Vec3 = [number, number, number];

/** フィールドの値（保存できる値。ADR 0065） */
export type FieldValue = Value;

/**
 * フィールドの定義。
 * - type：TypeScript の型の文（例：`number`、`Vec3`、`EntityRef | undefined`、`Card[]`。ADR 0065）。
 *   Tukurium が用意する型の名前は `FIELD_TYPE` にある。
 * - default：初期値。型とは別に持つ。
 */
export interface FieldDef {
  id: FieldId;
  name: string;
  type: string;
  default: FieldValue;
}

/** Tukurium が用意する、よく使う型の文（Host API の宣言にある型の名前。ADR 0065） */
export const FIELD_TYPE = {
  number: "number",
  boolean: "boolean",
  string: "string",
  vec3: "Vec3",
  color: "Color",
  entity: "EntityRef | undefined",
  texture: "TextureRef | undefined",
  material: "MaterialRef | undefined",
  model: "ModelRef | undefined",
  audio: "AudioRef | undefined",
} as const;

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
