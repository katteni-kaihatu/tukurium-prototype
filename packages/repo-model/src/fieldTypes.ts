import {
  conformValue,
  FIELD_TYPE,
  type FieldSchemas,
  type FieldValue,
  type KokoStateDef,
  REF_TARGETS,
  type RefTarget,
  schemaOfField,
  type ValueSchema,
  validateValue,
} from "@tukurium/eks";
import { BUILTIN_KOKOSTATES, isBuiltin } from "./builtins";
import { type Diagnostic, type DiagnosticInput, makeDiagnostic } from "./diagnostics/types";
import type { ProjectSnapshot } from "./schema";

/**
 * 一覧から選べる、よく使う型（ADR 0065）。フィールドの型は TypeScript の型の文で持つので、
 * ここにあるのは「選ぶだけで書ける型の文」と、その初期値。込み入った型は TypeScript で書く。
 */
export interface BasicFieldType {
  /** 一覧の中での名前（エージェントの道具の引数にも使う） */
  key: keyof typeof FIELD_TYPE;
  label: string;
  /** 型の文 */
  type: string;
  default: FieldValue;
}

export const BASIC_FIELD_TYPES: readonly BasicFieldType[] = [
  { key: "number", label: "Number", type: FIELD_TYPE.number, default: 0 },
  { key: "boolean", label: "Bool", type: FIELD_TYPE.boolean, default: false },
  { key: "string", label: "Text", type: FIELD_TYPE.string, default: "" },
  { key: "vec3", label: "Vector3", type: FIELD_TYPE.vec3, default: [0, 0, 0] },
  { key: "color", label: "Color", type: FIELD_TYPE.color, default: "#ffffff" },
  { key: "entity", label: "Entity", type: FIELD_TYPE.entity, default: undefined },
  { key: "texture", label: "Texture", type: FIELD_TYPE.texture, default: undefined },
  { key: "material", label: "Material", type: FIELD_TYPE.material, default: undefined },
  { key: "model", label: "Model", type: FIELD_TYPE.model, default: undefined },
  { key: "audio", label: "Audio", type: FIELD_TYPE.audio, default: undefined },
];

/** 型の文が、一覧から選べる型のどれか（空白の違いは問わない） */
export function basicFieldType(typeText: string): BasicFieldType | undefined {
  const norm = (s: string) => s.replace(/\s+/g, "");
  return BASIC_FIELD_TYPES.find((t) => norm(t.type) === norm(typeText));
}

/** フィールドの値の問題の担い手（問題の一覧の「出どころ」） */
export const VALUES_PROVIDER = "values";

/**
 * フィールドの値が、型（スキーマ）に合っているかを確かめる（ADR 0065）。
 * - Entity の値が合わない：その Entity のフィールドの問題
 * - 初期値が合わない：その KokoState のフィールドの問題
 * スキーマがないフィールド（型エラーがある、まだ TypeScript の準備ができていない）は確かめない。
 * その型エラーは、型の確かめが別に出す。
 */
export function checkFieldValues(snap: ProjectSnapshot, schemas?: FieldSchemas): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (d: Omit<DiagnosticInput, "phase" | "provider" | "severity" | "related">) =>
    out.push(
      makeDiagnostic({
        ...d,
        severity: "error",
        related: [],
        phase: "authoring",
        provider: VALUES_PROVIDER,
      }),
    );
  const defs = new Map<string, KokoStateDef>();
  for (const k of [...BUILTIN_KOKOSTATES, ...snap.kokostates]) defs.set(k.id, k);

  for (const k of snap.kokostates) {
    for (const f of k.fields) {
      const schema = schemaOfField(schemas, k.id, f);
      // 型の定義を変えたあとの値は、足りないフィールドを埋め、型にないフィールドを捨てた形で確かめる
      // （実行でも同じ形にして使う）。それでも合わない所（型が変わった所）だけを、問題にする
      const bad = schema ? validateValue(schema, conformValue(schema, f.default)) : null;
      if (bad)
        push({
          code: "default-type-mismatch",
          subject: { kind: "kokostate", id: k.id },
          location: { kind: "property", path: [f.id, "default"] },
          message: `「${k.name}」の ${f.name} の初期値が、型（${f.type}）に合いません`,
          detail: bad,
        });
    }
  }
  for (const e of snap.entities) {
    for (const [kokoId, values] of Object.entries(e.states)) {
      const def = defs.get(kokoId);
      if (!def) continue;
      for (const f of def.fields) {
        if (!Object.hasOwn(values, f.id)) continue;
        const schema = schemaOfField(schemas, kokoId, f);
        // Built-in の数（位置・大きさなど）は、描画と物理がそのまま使うので、有限の数に限る
        const bad = schema
          ? validateValue(schema, conformValue(schema, values[f.id]), {
              finite: isBuiltin(kokoId),
            })
          : null;
        if (bad)
          push({
            code: "value-type-mismatch",
            subject: { kind: "entity", id: e.id },
            location: { kind: "property", path: [kokoId, f.id] },
            message: `「${e.name}」の ${def.name}.${f.name} の値が、型（${f.type}）に合いません`,
            detail: bad,
          });
      }
    }
  }
  return out;
}

/** 参照の指す先の、画面での呼び方 */
export const REF_TARGET_LABEL: Record<RefTarget, string> = {
  entity: "Entity",
  texture: "テクスチャ",
  material: "マテリアル",
  model: "モデル",
  audio: "音声",
};

const isRefTarget = (v: unknown): v is RefTarget =>
  typeof v === "string" && (REF_TARGETS as readonly string[]).includes(v);

/** 入れ子の深さの上限（外から届いたスキーマで、止まらなくなるのを防ぐ） */
const MAX_SCHEMA_DEPTH = 32;

function parseSchema(v: unknown, depth: number): ValueSchema | undefined {
  if (depth > MAX_SCHEMA_DEPTH || v === null || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  const child = (x: unknown) => parseSchema(x, depth + 1);
  switch (s.kind) {
    case "number":
    case "string":
    case "boolean":
    case "bigint":
    case "undefined":
    case "color":
    case "Date":
      return { kind: s.kind };
    case "literal":
      return ["string", "number", "boolean"].includes(typeof s.value)
        ? { kind: "literal", value: s.value as string | number | boolean }
        : undefined;
    case "ref":
      return isRefTarget(s.target) ? { kind: "ref", target: s.target } : undefined;
    case "kokoRef":
      return typeof s.koko === "string" ? { kind: "kokoRef", koko: s.koko } : { kind: "kokoRef" };
    case "fieldRef": {
      if (s.value === undefined) return { kind: "fieldRef" };
      const value = child(s.value);
      return value ? { kind: "fieldRef", value } : undefined;
    }
    case "union":
    case "tuple": {
      const list = Array.isArray(s.kind === "union" ? s.options : s.items)
        ? ((s.kind === "union" ? s.options : s.items) as unknown[]).map(child)
        : undefined;
      if (!list || list.some((x) => x === undefined)) return undefined;
      const items = list as ValueSchema[];
      return s.kind === "union" ? { kind: "union", options: items } : { kind: "tuple", items };
    }
    case "list":
    case "Set": {
      const item = child(s.item);
      return item ? { kind: s.kind, item } : undefined;
    }
    case "map": {
      const value = child(s.value);
      return value ? { kind: "map", value } : undefined;
    }
    case "Map": {
      const key = child(s.key);
      const value = child(s.value);
      return key && value ? { kind: "Map", key, value } : undefined;
    }
    case "record": {
      if (!Array.isArray(s.fields)) return undefined;
      const fields = [];
      for (const f of s.fields as Record<string, unknown>[]) {
        const schema = child(f?.schema);
        if (!schema || typeof f.name !== "string") return undefined;
        fields.push({ name: f.name, schema, optional: f.optional === true });
      }
      return { kind: "record", fields };
    }
    default:
      return undefined;
  }
}

/**
 * 外から届いたスキーマ（通信で受け取ったもの）を、形を確かめて受け取る。
 * 形が合わないフィールドは捨てる（スキーマがないフィールドとして、値の確かめをせずに通る）。
 */
export function parseFieldSchemas(value: unknown): FieldSchemas {
  const out: FieldSchemas = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [koko, fields] of Object.entries(value)) {
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) continue;
    const parsed: Record<string, ValueSchema> = {};
    for (const [field, schema] of Object.entries(fields)) {
      const s = parseSchema(schema, 0);
      if (s) parsed[field] = s;
    }
    out[koko] = parsed;
  }
  return out;
}
