import { isPlainObject, type Value } from "./value";

/**
 * 値の形の決まり（スキーマ。ADR 0065）。フィールドの型（TypeScript の型の文）を読み解いた結果で、
 * 値の確かめ・Inspector の入力・参照のたどり方は、これを見て決める。
 * 型の文からスキーマを作るのは TypeScript の本体（`packages/typecheck`）。よく使う型だけは、
 * TypeScript を読み込まずに `knownSchema()` で作れる。スキーマは保存しない（制作データから作り直す）。
 */

/** 参照が指すもの（Entity と、リソースの種類） */
export type RefTarget = "entity" | "texture" | "material" | "model" | "audio";

export const REF_TARGETS: readonly RefTarget[] = [
  "entity",
  "texture",
  "material",
  "model",
  "audio",
];

export type ValueSchema =
  | { kind: "number" }
  | { kind: "string" }
  | { kind: "boolean" }
  | { kind: "bigint" }
  | { kind: "undefined" }
  /** 選択肢の一つ（文字・数・真偽のリテラル） */
  | { kind: "literal"; value: string | number | boolean }
  /** 色（"#rrggbb" の文字） */
  | { kind: "color" }
  /** Entity・リソースの ID */
  | { kind: "ref"; target: RefTarget }
  /**
   * Entity についた KokoState の参照（`KokoStateRef<K>`）。値は `{ entity, koko }`（Entity と KokoState の ID）。
   * koko：指せる KokoState の ID（ないときは、どの KokoState でも指せる）
   */
  | { kind: "kokoRef"; koko?: string }
  /**
   * Entity についた KokoState のフィールドの参照（`FieldRef<T>`）。値は `{ entity, koko, field }`
   * （Entity・KokoState・フィールドの ID）。value：指せるフィールドの型（ないときは、どのフィールドでも指せる）
   */
  | { kind: "fieldRef"; value?: ValueSchema }
  | { kind: "union"; options: ValueSchema[] }
  | { kind: "tuple"; items: ValueSchema[] }
  | { kind: "list"; item: ValueSchema }
  | { kind: "record"; fields: RecordFieldSchema[] }
  /** `Record<string, V>`（文字のキーから値へ） */
  | { kind: "map"; value: ValueSchema }
  | { kind: "Map"; key: ValueSchema; value: ValueSchema }
  | { kind: "Set"; item: ValueSchema }
  | { kind: "Date" };

export interface RecordFieldSchema {
  name: string;
  schema: ValueSchema;
  /** 省略できる（`name?: T`） */
  optional: boolean;
}

/** Entity についた KokoState（と、そのフィールド）の参照の値。どれも名前ではなく ID */
export interface StateRefValue {
  entity: string;
  koko: string;
  /** フィールドの参照のときだけ */
  field?: string;
}

/** 値が、KokoState の参照（field が要るなら、フィールドの参照）の形か */
function isStateRef(value: unknown, withField: boolean): value is StateRefValue {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== (withField ? 3 : 2)) return false;
  if (typeof value.entity !== "string" || typeof value.koko !== "string") return false;
  return !withField || typeof value.field === "string";
}

/** KokoState の ID → フィールドの ID → スキーマ。スキーマを作れなかったフィールドは入らない */
export type FieldSchemas = Record<string, Record<string, ValueSchema>>;

const NUMBER: ValueSchema = { kind: "number" };
const UNDEFINED: ValueSchema = { kind: "undefined" };

/** Tukurium が用意する型の名前 → スキーマ（TypeScript を読み込まずに分かるもの） */
const KNOWN: Record<string, ValueSchema> = {
  number: NUMBER,
  string: { kind: "string" },
  boolean: { kind: "boolean" },
  bigint: { kind: "bigint" },
  Date: { kind: "Date" },
  Vec3: { kind: "tuple", items: [NUMBER, NUMBER, NUMBER] },
  Color: { kind: "color" },
  EntityRef: { kind: "ref", target: "entity" },
  TextureRef: { kind: "ref", target: "texture" },
  MaterialRef: { kind: "ref", target: "material" },
  ModelRef: { kind: "ref", target: "model" },
  AudioRef: { kind: "ref", target: "audio" },
};

/**
 * よく使う型の文から、TypeScript を読み込まずにスキーマを作る。
 * 分かるのは、Tukurium が用意する型の名前と、それに `| undefined` を付けたものだけ。
 * ほかの型の文（リスト・レコードなど）は undefined を返すので、TypeScript で作ったスキーマを使う。
 * 結果は、TypeScript で作ったスキーマと同じになる（`packages/typecheck` のテストが検査する）。
 */
export function knownSchema(typeText: string): ValueSchema | undefined {
  const parts = typeText.split("|").map((p) => p.trim());
  if (parts.length > 2 || parts.some((p) => p === "")) return undefined;
  const names = parts.filter((p) => p !== "undefined");
  if (names.length !== 1) return undefined;
  const base = KNOWN[names[0] as string];
  if (!base || !Object.hasOwn(KNOWN, names[0] as string)) return undefined;
  return parts.length === 1 ? base : { kind: "union", options: [base, UNDEFINED] };
}

/** フィールドのスキーマ：TypeScript で作ったものがあればそれ、なければ型の文から分かるもの */
export function schemaOfField(
  schemas: FieldSchemas | undefined,
  kokoId: string,
  field: { id: string; type: string },
): ValueSchema | undefined {
  return schemas?.[kokoId]?.[field.id] ?? knownSchema(field.type);
}

export interface ValidateOptions {
  /**
   * 数を、有限の数に限る（`NaN`・`Infinity` を断る）。Built-in の KokoState（位置や速度など）は、
   * 描画と物理がそのまま使うので、これを付けて確かめる。
   */
  finite?: boolean;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

const kindOf = (value: object): string => Object.prototype.toString.call(value);

const at = (path: string) => (path === "" ? "" : `${path}：`);

/**
 * 値がスキーマに合うかを確かめる。合えば null、合わなければ理由（どこが・何でないか）を返す。
 * 値ごとに TypeScript を動かすと重いので、確かめはいつもこちらで行う。
 */
export function validateValue(
  schema: ValueSchema,
  value: unknown,
  options: ValidateOptions = {},
  path = "",
): string | null {
  switch (schema.kind) {
    case "number":
      if (typeof value !== "number") return `${at(path)}数ではありません`;
      if (options.finite && !Number.isFinite(value)) return `${at(path)}有限の数ではありません`;
      return null;
    case "string":
      return typeof value === "string" ? null : `${at(path)}文字ではありません`;
    case "boolean":
      return typeof value === "boolean" ? null : `${at(path)}真偽ではありません`;
    case "bigint":
      return typeof value === "bigint" ? null : `${at(path)}大きな整数（bigint）ではありません`;
    case "undefined":
      return value === undefined ? null : `${at(path)}undefined ではありません`;
    case "literal":
      return value === schema.value
        ? null
        : `${at(path)}${JSON.stringify(schema.value)} ではありません`;
    case "color":
      return typeof value === "string" && COLOR.test(value)
        ? null
        : `${at(path)}色（"#rrggbb"）ではありません`;
    case "ref":
      return typeof value === "string" ? null : `${at(path)}参照（ID の文字）ではありません`;
    case "kokoRef":
      if (!isStateRef(value, false)) return `${at(path)}KokoState の参照ではありません`;
      // 指せる KokoState が決まっていれば、その KokoState の参照に限る
      return schema.koko === undefined || value.koko === schema.koko
        ? null
        : `${at(path)}この型で指せる KokoState ではありません`;
    case "fieldRef":
      // 指したフィールドの型が合うかは、制作データを見て確かめる（参照の診断）
      return isStateRef(value, true) ? null : `${at(path)}フィールドの参照ではありません`;
    case "union": {
      for (const option of schema.options)
        if (validateValue(option, value, options, path) === null) return null;
      return `${at(path)}どの型にも合いません`;
    }
    case "tuple": {
      if (!Array.isArray(value) || value.length !== schema.items.length)
        return `${at(path)}${schema.items.length} 個の並びではありません`;
      for (let i = 0; i < schema.items.length; i++) {
        const bad = validateValue(
          schema.items[i] as ValueSchema,
          value[i],
          options,
          `${path}[${i}]`,
        );
        if (bad) return bad;
      }
      return null;
    }
    case "list": {
      if (!Array.isArray(value)) return `${at(path)}リストではありません`;
      for (let i = 0; i < value.length; i++) {
        const bad = validateValue(schema.item, value[i], options, `${path}[${i}]`);
        if (bad) return bad;
      }
      return null;
    }
    case "record": {
      if (!isPlainObject(value)) return `${at(path)}レコードではありません`;
      const known = new Set<string>();
      for (const f of schema.fields) {
        known.add(f.name);
        const child = path === "" ? f.name : `${path}.${f.name}`;
        const v = Object.hasOwn(value, f.name) ? value[f.name] : undefined;
        // 省略できるフィールドは、キーがなくても undefined でもよい。キーがないことは undefined と同じに扱う
        if (v === undefined && f.optional) continue;
        const bad = validateValue(f.schema, v, options, child);
        if (bad) return bad;
      }
      for (const key of Object.keys(value))
        if (!known.has(key)) return `${at(path)}「${key}」は、型にないフィールドです`;
      return null;
    }
    case "map": {
      if (!isPlainObject(value)) return `${at(path)}マップではありません`;
      for (const key of Object.keys(value)) {
        const bad = validateValue(
          schema.value,
          value[key],
          options,
          `${path}[${JSON.stringify(key)}]`,
        );
        if (bad) return bad;
      }
      return null;
    }
    case "Map": {
      if (value === null || typeof value !== "object" || kindOf(value) !== "[object Map]")
        return `${at(path)}Map ではありません`;
      for (const [k, v] of value as Map<unknown, unknown>) {
        const bad =
          validateValue(schema.key, k, options, `${path}（キー）`) ??
          validateValue(schema.value, v, options, `${path}（値）`);
        if (bad) return bad;
      }
      return null;
    }
    case "Set": {
      if (value === null || typeof value !== "object" || kindOf(value) !== "[object Set]")
        return `${at(path)}Set ではありません`;
      for (const v of value as Set<unknown>) {
        const bad = validateValue(schema.item, v, options, `${path}（要素）`);
        if (bad) return bad;
      }
      return null;
    }
    case "Date":
      return value !== null && typeof value === "object" && kindOf(value) === "[object Date]"
        ? null
        : `${at(path)}日時（Date）ではありません`;
  }
}

/**
 * 値の中の参照（入れ子の中も）を、スキーマに沿ってたどる。
 * KokoState の参照・フィールドの参照は、その Entity を Entity の参照としてたどる。
 */
export function visitRefs(
  schema: ValueSchema,
  value: unknown,
  visit: (target: RefTarget, id: string) => void,
): void {
  switch (schema.kind) {
    case "ref":
      if (typeof value === "string" && value !== "") visit(schema.target, value);
      return;
    case "kokoRef":
    case "fieldRef":
      if (isStateRef(value, schema.kind === "fieldRef") && value.entity !== "")
        visit("entity", value.entity);
      return;
    case "union": {
      // 値に合う選択肢だけをたどる（文字と参照が並ぶ型で、ただの文字を参照と取り違えない）
      const option = schema.options.find((o) => validateValue(o, value) === null);
      if (option) visitRefs(option, value, visit);
      return;
    }
    case "tuple":
      if (Array.isArray(value))
        schema.items.forEach((item, i) => {
          visitRefs(item, value[i], visit);
        });
      return;
    case "list":
      if (Array.isArray(value)) for (const v of value) visitRefs(schema.item, v, visit);
      return;
    case "record":
      if (isPlainObject(value))
        for (const f of schema.fields) visitRefs(f.schema, value[f.name], visit);
      return;
    case "map":
      if (isPlainObject(value))
        for (const key of Object.keys(value)) visitRefs(schema.value, value[key], visit);
      return;
    case "Map":
      if (value instanceof Map)
        for (const [k, v] of value) {
          visitRefs(schema.key, k, visit);
          visitRefs(schema.value, v, visit);
        }
      return;
    case "Set":
      if (value instanceof Set) for (const v of value) visitRefs(schema.item, v, visit);
      return;
    default:
      return;
  }
}

/**
 * 値の中の、KokoState の参照とフィールドの参照（入れ子の中も）を、スキーマに沿ってたどる。
 * 参照先（Entity がその KokoState を持っているか、フィールドがあるか、型が合うか）を確かめるのに使う。
 */
export function visitStateRefs(
  schema: ValueSchema,
  value: unknown,
  visit: (ref: StateRefValue, schema: ValueSchema & { kind: "kokoRef" | "fieldRef" }) => void,
): void {
  switch (schema.kind) {
    case "kokoRef":
    case "fieldRef":
      if (isStateRef(value, schema.kind === "fieldRef")) visit(value, schema);
      return;
    case "union": {
      const option = schema.options.find((o) => validateValue(o, value) === null);
      if (option) visitStateRefs(option, value, visit);
      return;
    }
    case "tuple":
      if (Array.isArray(value))
        schema.items.forEach((item, i) => {
          visitStateRefs(item, value[i], visit);
        });
      return;
    case "list":
      if (Array.isArray(value)) for (const v of value) visitStateRefs(schema.item, v, visit);
      return;
    case "record":
      if (isPlainObject(value))
        for (const f of schema.fields) visitStateRefs(f.schema, value[f.name], visit);
      return;
    case "map":
      if (isPlainObject(value))
        for (const key of Object.keys(value)) visitStateRefs(schema.value, value[key], visit);
      return;
    case "Map":
      if (value instanceof Map)
        for (const [k, v] of value) {
          visitStateRefs(schema.key, k, visit);
          visitStateRefs(schema.value, v, visit);
        }
      return;
    case "Set":
      if (value instanceof Set) for (const v of value) visitStateRefs(schema.item, v, visit);
      return;
    default:
      return;
  }
}

/**
 * 値の中の参照を、スキーマに沿って置き換えた値を返す（抽出で ID を振り直すときに使う）。
 * replace が undefined を返した参照は、そのままにする。元の値は書き換えない。
 * KokoState の参照・フィールドの参照は、Entity の ID（"entity"）と KokoState の ID（"kokostate"）を置き換える。
 */
export function mapRefs(
  schema: ValueSchema,
  value: unknown,
  replace: (target: RefTarget | "kokostate", id: string) => string | undefined,
): unknown {
  switch (schema.kind) {
    case "ref":
      return typeof value === "string" ? (replace(schema.target, value) ?? value) : value;
    case "kokoRef":
    case "fieldRef":
      return isStateRef(value, schema.kind === "fieldRef")
        ? {
            ...value,
            entity: replace("entity", value.entity) ?? value.entity,
            koko: replace("kokostate", value.koko) ?? value.koko,
          }
        : value;
    case "union": {
      const option = schema.options.find((o) => validateValue(o, value) === null);
      return option ? mapRefs(option, value, replace) : value;
    }
    case "tuple":
      return Array.isArray(value)
        ? value.map((v, i) => {
            const item = schema.items[i];
            return item ? mapRefs(item, v, replace) : v;
          })
        : value;
    case "list":
      return Array.isArray(value) ? value.map((v) => mapRefs(schema.item, v, replace)) : value;
    case "record": {
      if (!isPlainObject(value)) return value;
      const out: Record<string, unknown> = { ...value };
      for (const f of schema.fields)
        if (Object.hasOwn(value, f.name)) out[f.name] = mapRefs(f.schema, value[f.name], replace);
      return out;
    }
    case "map": {
      if (!isPlainObject(value)) return value;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) out[key] = mapRefs(schema.value, value[key], replace);
      return out;
    }
    case "Map":
      return value instanceof Map
        ? new Map(
            [...value].map(([k, v]) => [
              mapRefs(schema.key, k, replace),
              mapRefs(schema.value, v, replace),
            ]),
          )
        : value;
    case "Set":
      return value instanceof Set
        ? new Set([...value].map((v) => mapRefs(schema.item, v, replace)))
        : value;
    default:
      return value;
  }
}

/** スキーマの中に参照があるか */
export function hasRefs(schema: ValueSchema): boolean {
  switch (schema.kind) {
    case "ref":
    case "kokoRef":
    case "fieldRef":
      return true;
    case "union":
      return schema.options.some(hasRefs);
    case "tuple":
      return schema.items.some(hasRefs);
    case "list":
    case "Set":
      return hasRefs(schema.item);
    case "record":
      return schema.fields.some((f) => hasRefs(f.schema));
    case "map":
      return hasRefs(schema.value);
    case "Map":
      return hasRefs(schema.key) || hasRefs(schema.value);
    default:
      return false;
  }
}

/** スキーマが undefined を受け入れるか（「なし」にできるか） */
export function acceptsUndefined(schema: ValueSchema): boolean {
  return validateValue(schema, undefined) === null;
}

/**
 * このスキーマに合う値が、いつもふつうの JSON で表せるか（`"$t"` のキーも持ちえないか）。
 * true のフィールドは、スクリプトとの間を `JSON.parse`・`JSON.stringify` だけで運べる（ADR 0065）。
 * finite：数を有限に限って確かめるフィールド（Built-in）なら true。限らなければ、数は `NaN` を持ちうる。
 */
export function isJsonSafe(schema: ValueSchema, finite: boolean): boolean {
  switch (schema.kind) {
    case "number":
      return finite;
    case "string":
    case "boolean":
    case "literal":
    case "color":
    case "ref":
    // 参照の値は、ID の文字だけのレコード
    case "kokoRef":
    case "fieldRef":
      return true;
    case "union":
      return schema.options.every((o) => isJsonSafe(o, finite));
    case "tuple":
      return schema.items.every((o) => isJsonSafe(o, finite));
    case "list":
      return isJsonSafe(schema.item, finite);
    case "record":
      // 省略できるフィールドの undefined は、キーがないのと同じなので、JSON で落ちてもよい
      return schema.fields.every((f) => f.name !== "$t" && isJsonSafe(f.schema, finite));
    default:
      // undefined・bigint・Date・Map・Set は JSON で表せない。Record<string, V> はキーに "$t" を持ちうる
      return false;
  }
}

/** 数 3 つの並び（`Vec3`）か */
export function isVec3Schema(schema: ValueSchema): boolean {
  return (
    schema.kind === "tuple" &&
    schema.items.length === 3 &&
    schema.items.every((i) => i.kind === "number")
  );
}

/**
 * 「なし」にできる参照（`EntityRef | undefined` など）なら、その指す先。Inspector の「（なし）」付きの
 * 選択や、エージェントの名前での指定に使う。必ず指す参照（`EntityRef`）も同じく返す。
 */
export function refTargetOf(schema: ValueSchema): RefTarget | undefined {
  if (schema.kind === "ref") return schema.target;
  if (schema.kind !== "union") return undefined;
  const rest = schema.options.filter((o) => o.kind !== "undefined");
  return rest.length === 1 && rest[0]?.kind === "ref" ? rest[0].target : undefined;
}

/** 初期値として使える値（型が undefined を受け入れるなら undefined。ほかは、型ごとの空の値） */
export function emptyValueOf(schema: ValueSchema): Value {
  if (acceptsUndefined(schema)) return undefined;
  switch (schema.kind) {
    case "number":
      return 0;
    case "string":
    case "ref":
      return "";
    case "boolean":
      return false;
    case "bigint":
      return 0n;
    case "literal":
      return schema.value;
    case "color":
      return "#ffffff";
    case "kokoRef":
      return { entity: "", koko: schema.koko ?? "" };
    case "fieldRef":
      return { entity: "", koko: "", field: "" };
    case "union":
      return schema.options[0] ? emptyValueOf(schema.options[0]) : undefined;
    case "tuple":
      return schema.items.map(emptyValueOf);
    case "list":
      return [];
    case "record":
      return Object.fromEntries(
        schema.fields.filter((f) => !f.optional).map((f) => [f.name, emptyValueOf(f.schema)]),
      );
    case "map":
      return {};
    case "Map":
      return new Map();
    case "Set":
      return new Set();
    case "Date":
      return new Date(0);
    default:
      return undefined;
  }
}

/**
 * 値を、型（スキーマ）に合わせる（ADR 0065）。型の定義を変えたあとの、すでにある値に使う。
 * - レコードに足りないフィールドは、空の値（`emptyValueOf`）で埋める。省略できるフィールドは埋めない
 * - 型にないフィールドは捨てる
 * - 型が変わった所（数だった所が文字になった、など）は、そのまま残す（値の問題として出る）
 * 元の値は書き換えない。
 */
export function conformValue(schema: ValueSchema, value: unknown): unknown {
  switch (schema.kind) {
    case "record": {
      if (!isPlainObject(value)) return value;
      const out: Record<string, unknown> = {};
      for (const f of schema.fields) {
        if (Object.hasOwn(value, f.name)) out[f.name] = conformValue(f.schema, value[f.name]);
        else if (!f.optional) out[f.name] = emptyValueOf(f.schema);
      }
      return out;
    }
    case "list":
      return Array.isArray(value) ? value.map((v) => conformValue(schema.item, v)) : value;
    case "tuple":
      return Array.isArray(value) && value.length === schema.items.length
        ? value.map((v, i) => conformValue(schema.items[i] as ValueSchema, v))
        : value;
    case "map": {
      if (!isPlainObject(value)) return value;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) out[key] = conformValue(schema.value, value[key]);
      return out;
    }
    case "Map":
      return value instanceof Map
        ? new Map(
            [...value].map(([k, v]) => [
              conformValue(schema.key, k),
              conformValue(schema.value, v),
            ]),
          )
        : value;
    case "Set":
      return value instanceof Set
        ? new Set([...value].map((v) => conformValue(schema.item, v)))
        : value;
    case "union": {
      // そのままで合う選択肢があれば、それに合わせる。なければ、合わせれば合う選択肢を探す
      const direct = schema.options.find((o) => validateValue(o, value) === null);
      if (direct) return conformValue(direct, value);
      for (const option of schema.options) {
        const conformed = conformValue(option, value);
        if (validateValue(option, conformed) === null) return conformed;
      }
      return value;
    }
    default:
      return value;
  }
}
