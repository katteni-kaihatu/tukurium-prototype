import type { RefTarget, ValueSchema } from "@tukurium/eks";
import ts from "typescript6";

/**
 * フィールドの型（TypeScript の型の文）を、値の形の決まり（スキーマ）に変える（ADR 0065）。
 * 型を読み解くのは TypeScript の型の確かめ（TypeChecker）。保存できない型（関数・クラス・Promise など）は
 * スキーマに変えられないので、理由を付けて断る（フィールドの型エラーになる）。
 */

/** 保存できない型だったときの理由 */
export class UnsaveableType extends Error {}

const unsaveable = (message: string): never => {
  throw new UnsaveableType(message);
};

/** Host API の宣言にある参照の型（`string & { __tukurium: "EntityRef" }`）の名前 → 指す先 */
const REF_BRANDS: Record<string, RefTarget> = {
  EntityRef: "entity",
  TextureRef: "texture",
  MaterialRef: "material",
  ModelRef: "model",
  AudioRef: "audio",
};
const BRAND = "__tukurium";

/** 入れ子の深さの上限（自分を含む型などで、止まらなくなるのを防ぐ） */
const MAX_DEPTH = 16;

/**
 * 型の文が、型 1 つとして読めるかを確かめる（TypeScript の本体は要るが、プログラム全体は作らない）。
 * 読めなければ理由を返す。`number; declare const x: 1` のように、続きに別の文を書いたものも断る。
 */
export function fieldTypeSyntaxError(typeText: string): string | null {
  if (typeText.trim() === "") return "型を書いてください";
  const source = ts.createSourceFile(
    "/field.ts",
    `type T = (\n${typeText}\n);`,
    ts.ScriptTarget.ES2022,
    false,
  );
  const parse = (source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  const first = parse?.[0];
  if (first) return ts.flattenDiagnosticMessageText(first.messageText, " ");
  const only = source.statements.length === 1 ? source.statements[0] : undefined;
  if (!only || !ts.isTypeAliasDeclaration(only)) return "型を 1 つだけ書いてください";
  return null;
}

export interface SchemaContext {
  checker: ts.TypeChecker;
  /** 標準ライブラリの宣言のファイルか（`Date`・`Map`・`Set` を、利用者が作った同じ名前の型と取り違えない） */
  isLibFile(fileName: string): boolean;
}

/** undefined を最後に置く（`knownSchema()` の結果と同じ並びにする） */
function ordered(options: ValueSchema[]): ValueSchema[] {
  return [
    ...options.filter((o) => o.kind !== "undefined"),
    ...options.filter((o) => o.kind === "undefined"),
  ];
}

function unionOf(options: ValueSchema[]): ValueSchema {
  // true と false の両方があれば、真偽にまとめる
  const hasTrue = options.some((o) => o.kind === "literal" && o.value === true);
  const hasFalse = options.some((o) => o.kind === "literal" && o.value === false);
  let list = options;
  if (hasTrue && hasFalse) {
    list = options.filter((o) => !(o.kind === "literal" && typeof o.value === "boolean"));
    list.push({ kind: "boolean" });
  }
  // 同じものは一つにする
  const seen = new Set<string>();
  const unique = list.filter((o) => {
    const key = JSON.stringify(o);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const only = unique.length === 1 ? unique[0] : undefined;
  return only ?? { kind: "union", options: ordered(unique) };
}

/** TypeScript の型をスキーマに変える。保存できない型なら UnsaveableType を投げる */
export function typeToSchema(ctx: SchemaContext, type: ts.Type, depth = 0): ValueSchema {
  if (depth > MAX_DEPTH) return unsaveable("入れ子が深すぎます（自分を含む型は使えません）");
  const { checker } = ctx;
  const flags = type.flags;
  const next = (t: ts.Type) => typeToSchema(ctx, t, depth + 1);

  if (flags & ts.TypeFlags.Any)
    return unsaveable("any は使えません。保存する値の型を書いてください");
  if (flags & ts.TypeFlags.Unknown)
    return unsaveable("unknown は使えません。保存する値の型を書いてください");
  if (flags & ts.TypeFlags.Never) return unsaveable("never は使えません");
  if (flags & ts.TypeFlags.Null)
    return unsaveable("null は使えません。「なし」は undefined で書きます");
  if (flags & ts.TypeFlags.Void)
    return unsaveable("void は使えません。「なし」は undefined で書きます");
  if (flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol))
    return unsaveable("symbol は保存できません");
  if (flags & ts.TypeFlags.NonPrimitive)
    return unsaveable("object は使えません。レコードの形を書いてください");
  if (flags & ts.TypeFlags.Undefined) return { kind: "undefined" };
  if (flags & ts.TypeFlags.EnumLike)
    return unsaveable("enum は使えません。文字の選択肢で書いてください");
  if (flags & ts.TypeFlags.StringLiteral)
    return { kind: "literal", value: (type as ts.StringLiteralType).value };
  if (flags & ts.TypeFlags.NumberLiteral)
    return { kind: "literal", value: (type as ts.NumberLiteralType).value };
  if (flags & ts.TypeFlags.BooleanLiteral)
    return { kind: "literal", value: checker.typeToString(type) === "true" };
  if (flags & ts.TypeFlags.BigIntLiteral) return { kind: "bigint" };
  if (flags & ts.TypeFlags.String) return { kind: "string" };
  if (flags & ts.TypeFlags.Number) return { kind: "number" };
  if (flags & ts.TypeFlags.Boolean) return { kind: "boolean" };
  if (flags & ts.TypeFlags.BigInt) return { kind: "bigint" };
  if (flags & ts.TypeFlags.TemplateLiteral) {
    // `#${string}`（Color）は色。ほかのテンプレートの型は、文字として扱う
    const t = type as ts.TemplateLiteralType;
    const isColor =
      t.texts.length === 2 &&
      t.texts[0] === "#" &&
      t.texts[1] === "" &&
      t.types.length === 1 &&
      Boolean((t.types[0]?.flags ?? 0) & ts.TypeFlags.String);
    return isColor ? { kind: "color" } : { kind: "string" };
  }
  if (type.isUnion()) return unionOf(type.types.map(next));
  if (type.isIntersection()) {
    const brand = type.getProperty(BRAND);
    if (brand) {
      const name = checker.getTypeOfSymbol(brand);
      const target = name.isStringLiteral() ? REF_BRANDS[name.value] : undefined;
      if (target) return { kind: "ref", target };
    }
    if (!type.types.every((t) => t.flags & ts.TypeFlags.Object))
      return unsaveable(`${checker.typeToString(type)} は保存できません`);
    return objectSchema(ctx, type, depth);
  }
  if (flags & ts.TypeFlags.Object) return objectSchema(ctx, type, depth);
  return unsaveable(`${checker.typeToString(type)} は保存できません`);
}

function objectSchema(ctx: SchemaContext, type: ts.Type, depth: number): ValueSchema {
  const { checker } = ctx;
  const next = (t: ts.Type) => typeToSchema(ctx, t, depth + 1);

  if (checker.isTupleType(type)) {
    const target = (type as ts.TupleTypeReference).target;
    if (target.elementFlags.some((f) => f !== ts.ElementFlags.Required))
      return unsaveable("省略できる要素・残りの要素を持つタプルは使えません");
    return { kind: "tuple", items: checker.getTypeArguments(type as ts.TypeReference).map(next) };
  }
  if (checker.isArrayType(type)) {
    const item = checker.getTypeArguments(type as ts.TypeReference)[0];
    return item ? { kind: "list", item: next(item) } : unsaveable("リストの要素の型が分かりません");
  }

  // 標準ライブラリの型は、Date・Map・Set だけを保存できる。`Record<K, V>` も標準ライブラリの型だが、
  // 名前の付いた interface ではないので、ここには当たらない（下の、添え字とプロパティで読む）
  const symbol = type.getSymbol();
  const fromLib =
    symbol !== undefined &&
    Boolean(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) &&
    (symbol.declarations ?? []).some((d) => ctx.isLibFile(d.getSourceFile().fileName));
  if (symbol && fromLib) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    const [first, second] = args;
    switch (symbol.getName()) {
      case "Date":
        return { kind: "Date" };
      case "Map":
      case "ReadonlyMap":
        if (first && second) return { kind: "Map", key: next(first), value: next(second) };
        break;
      case "Set":
      case "ReadonlySet":
        if (first) return { kind: "Set", item: next(first) };
        break;
    }
    return unsaveable(`${symbol.getName()} は保存できません`);
  }
  if (
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
  )
    return unsaveable("関数は保存できません");
  if (symbol && symbol.flags & ts.SymbolFlags.Class) return unsaveable("クラスは保存できません");

  const props = checker.getPropertiesOfType(type);
  const indexes = checker.getIndexInfosOfType(type);
  if (indexes.length > 0) {
    const index = indexes[0];
    if (indexes.length > 1 || !index || !(index.keyType.flags & ts.TypeFlags.String))
      return unsaveable(
        "マップのキーは文字にしてください（`Record<string, V>`）。ほかのキーは `Map<K, V>` で書けます",
      );
    if (props.length > 0)
      return unsaveable("決まったフィールドと、文字のキーのマップを、一つの型に混ぜられません");
    return { kind: "map", value: next(index.type) };
  }
  return {
    kind: "record",
    fields: props.map((p) => {
      try {
        return {
          name: p.getName(),
          schema: next(checker.getTypeOfSymbol(p)),
          optional: Boolean(p.flags & ts.SymbolFlags.Optional),
        };
      } catch (e) {
        if (e instanceof UnsaveableType) throw new UnsaveableType(`${p.getName()}：${e.message}`);
        throw e;
      }
    }),
  };
}
