import {
  emptyValueOf,
  equalValues,
  type FieldSchemas,
  isPlainObject,
  isVec3Schema,
  type KokoStateDef,
  parseValue,
  schemaOfField,
  type Value,
  type ValueSchema,
  validateValue,
} from "@tukurium/eks";

/**
 * 入れ子の値を Inspector で直すための、画面に寄らない部分（ADR 0065 の T6）。
 * 値は書き換えず、いつも新しい値を返す（制作データへは、フィールドの値をまるごと書く）。
 */

/**
 * 1 行に収まる入力で直せる型か。レコード・リスト・マップなどは、下に開いた枠の中で直す。
 */
export function isInlineSchema(schema: ValueSchema): boolean {
  switch (schema.kind) {
    case "tuple":
      return isVec3Schema(schema);
    case "union":
      return schema.options.every(isInlineSchema);
    case "list":
    case "record":
    case "map":
    case "Map":
    case "Set":
      return false;
    default:
      return true;
  }
}

/** 値の形が、型の大枠に合っているか（中身までは見ない）。合わない値は、直す前に空の値へ置き換えてもらう */
export function shapeMatches(schema: ValueSchema, value: unknown): boolean {
  switch (schema.kind) {
    case "tuple":
      return Array.isArray(value) && value.length === schema.items.length;
    case "list":
      return Array.isArray(value);
    case "record":
    case "map":
      return isPlainObject(value);
    case "kokoRef":
      // 指せない KokoState を指している値も、選び直せるように入力へ渡す
      return validateValue({ kind: "kokoRef" }, value) === null;
    case "union":
      return schema.options.some((o) => shapeMatches(o, value));
    default:
      return validateValue(schema, value) === null;
  }
}

/**
 * 値が、選択肢のどれに当たるか。中身まで合う選択肢を先に探し、なければ大枠が合うものを選ぶ
 * （中身に直し残しがあっても、その型の入力で続きを直せるように）。どれにも合わなければ -1。
 */
export function optionIndex(schema: ValueSchema & { kind: "union" }, value: unknown): number {
  const exact = schema.options.findIndex((o) => validateValue(o, value) === null);
  if (exact >= 0) return exact;
  return schema.options.findIndex((o) => shapeMatches(o, value));
}

/** 「なし」（undefined）を除いた型。省略できるフィールドを「ある」ときの入力に使う */
export function withoutUndefined(schema: ValueSchema): ValueSchema {
  if (schema.kind !== "union") return schema;
  const rest = schema.options.filter((o) => o.kind !== "undefined");
  if (rest.length === schema.options.length || rest.length === 0) return schema;
  return rest.length === 1 ? (rest[0] as ValueSchema) : { kind: "union", options: rest };
}

/** 足したときに入れる値。「なし」にできる型でも、できるだけ中身のある空の値にする */
export function fillValue(schema: ValueSchema): Value {
  return emptyValueOf(withoutUndefined(schema));
}

/**
 * KokoState の参照・フィールドの参照（か、それに `| undefined` を付けたもの）なら、その型と、
 * 「なし」にできるか。Entity やリソースの参照と同じく、「（なし）」付きの選択で直す。
 */
export function stateRefOf(
  schema: ValueSchema,
): { ref: ValueSchema & { kind: "kokoRef" | "fieldRef" }; optional: boolean } | undefined {
  if (schema.kind === "kokoRef" || schema.kind === "fieldRef")
    return { ref: schema, optional: false };
  if (schema.kind !== "union") return undefined;
  const rest = schema.options.filter((o) => o.kind !== "undefined");
  const only = rest[0];
  if (rest.length !== 1 || !only || (only.kind !== "kokoRef" && only.kind !== "fieldRef"))
    return undefined;
  return { ref: only, optional: rest.length < schema.options.length };
}

/** 型を短い文字で表す（選択肢の名前や、見出しの添え書きに使う） */
export function schemaLabel(schema: ValueSchema): string {
  switch (schema.kind) {
    case "number":
      return "Number";
    case "string":
      return "Text";
    case "boolean":
      return "Bool";
    case "bigint":
      return "BigInt";
    case "undefined":
      return "（なし）";
    case "literal":
      return typeof schema.value === "string" ? schema.value : String(schema.value);
    case "color":
      return "Color";
    case "ref":
      return {
        entity: "Entity",
        texture: "Texture",
        material: "Material",
        model: "Model",
        audio: "Audio",
      }[schema.target];
    case "kokoRef":
      return "KokoState の参照";
    case "fieldRef":
      return "フィールドの参照";
    case "union":
      return schema.options.map(schemaLabel).join(" | ");
    case "tuple":
      return isVec3Schema(schema) ? "Vector3" : `[${schema.items.map(schemaLabel).join(", ")}]`;
    case "list":
      return "リスト";
    case "record":
      return `{ ${schema.fields.map((f) => f.name).join(", ")} }`;
    case "map":
      return "マップ";
    case "Map":
      return "Map";
    case "Set":
      return "Set";
    case "Date":
      return "Date";
  }
}

/** 並びの中の一つを、別の位置へ動かす。動かせない位置なら、元の並びのまま */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item as T);
  return out;
}

/**
 * マップのキーの名前を変える（並びはそのまま）。空のキーと、すでにあるキーには変えられない（null）。
 */
export function renameKey(
  record: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> | null {
  if (to === from) return record;
  if (to === "" || Object.hasOwn(record, to) || !Object.hasOwn(record, from)) return null;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k === from ? to : k, v]));
}

/** マップに足すときの、まだ使っていないキー（key・key2・key3…） */
export function newKey(record: Record<string, unknown>): string {
  if (!Object.hasOwn(record, "key")) return "key";
  let n = 2;
  while (Object.hasOwn(record, `key${n}`)) n++;
  return `key${n}`;
}

/** マップからキーを一つ消す */
export function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/**
 * 値の形式の文字（タグ付きの JSON）を読み、型に合うかを確かめる。
 * 専用の入力がない型（Map・Set など）と、文字で直したいときに使う。合わなければ保存しない。
 */
export function parseTypedText(
  text: string,
  schema: ValueSchema | undefined,
): { ok: true; value: Value } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = parseValue(text);
  } catch (e) {
    return {
      ok: false,
      error: `値の形式として読めません：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const bad = schema ? validateValue(schema, value) : null;
  if (bad) return { ok: false, error: `型に合いません：${bad}` };
  return { ok: true, value: value as Value };
}

/** フィールドの参照で選べるフィールド */
export interface FieldChoice {
  koko: string;
  field: string;
  /** 「Health.hp」のような名前 */
  label: string;
}

/**
 * Entity が持つ KokoState のフィールドのうち、フィールドの参照で指せるもの。
 * want（`FieldRef<number>` の `number`）があれば、同じ型のフィールドだけ（文字のフィールドは選べない）。
 * 比べ方は、参照の診断（`field-ref-type-mismatch`）と同じ。
 */
export function fieldChoices(
  attached: readonly string[],
  defOf: (kokoId: string) => KokoStateDef | undefined,
  schemas: FieldSchemas | undefined,
  want: ValueSchema | undefined,
): FieldChoice[] {
  const out: FieldChoice[] = [];
  for (const koko of attached) {
    const def = defOf(koko);
    if (!def) continue;
    for (const f of def.fields) {
      if (want) {
        const schema = schemaOfField(schemas, koko, f);
        if (!schema || !equalValues(want, schema)) continue;
      }
      out.push({ koko, field: f.id, label: `${def.name}.${f.name}` });
    }
  }
  return out;
}

/** 見出しに添える件数（リスト・マップ・Map・Set）。ほかは空 */
export function countLabel(schema: ValueSchema, value: unknown): string {
  if (schema.kind === "list" && Array.isArray(value)) return `${value.length} 件`;
  if (schema.kind === "map" && isPlainObject(value)) return `${Object.keys(value).length} 件`;
  if (schema.kind === "Map" && value instanceof Map) return `${value.size} 件`;
  if (schema.kind === "Set" && value instanceof Set) return `${value.size} 件`;
  return "";
}
