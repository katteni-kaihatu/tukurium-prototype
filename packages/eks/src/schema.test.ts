import { describe, expect, it } from "vitest";
import {
  acceptsUndefined,
  hasRefs,
  isJsonSafe,
  isVec3Schema,
  knownSchema,
  mapRefs,
  refTargetOf,
  schemaOfField,
  type ValueSchema,
  validateValue,
  visitRefs,
} from "./schema";

const num: ValueSchema = { kind: "number" };
const str: ValueSchema = { kind: "string" };
const undef: ValueSchema = { kind: "undefined" };
const entity: ValueSchema = { kind: "ref", target: "entity" };

/** `{ suit: "spade" | "heart"; rank: number; joker?: boolean; owner: EntityRef | undefined }[]` */
const hand: ValueSchema = {
  kind: "list",
  item: {
    kind: "record",
    fields: [
      {
        name: "suit",
        optional: false,
        schema: {
          kind: "union",
          options: [
            { kind: "literal", value: "spade" },
            { kind: "literal", value: "heart" },
          ],
        },
      },
      { name: "rank", optional: false, schema: num },
      {
        name: "joker",
        optional: true,
        schema: { kind: "union", options: [{ kind: "boolean" }, undef] },
      },
      { name: "owner", optional: false, schema: { kind: "union", options: [entity, undef] } },
    ],
  },
};

describe("値をスキーマで確かめる（ADR 0065）", () => {
  it("入れ子の値を確かめ、合わない所と理由を返す", () => {
    const ok = [
      { suit: "spade", rank: 1, owner: "e1" },
      { suit: "heart", rank: 12, joker: undefined, owner: undefined },
    ];
    expect(validateValue(hand, ok)).toBeNull();
    expect(validateValue(hand, [])).toBeNull();
    expect(validateValue(hand, [{ suit: "club", rank: 1, owner: undefined }])).toMatch(
      /\[0\]\.suit/,
    );
    expect(validateValue(hand, [{ suit: "spade", rank: "1", owner: undefined }])).toMatch(
      /\[0\]\.rank：数ではありません/,
    );
    expect(validateValue(hand, [{ suit: "spade", rank: 1, owner: undefined, x: 1 }])).toMatch(
      /「x」は、型にないフィールド/,
    );
    expect(validateValue(hand, { 0: ok[0] })).toMatch(/リストではありません/);
    // 省略できないフィールドは、undefined を受け入れる型のときだけ、キーがなくてもよい
    expect(validateValue(hand, [{ suit: "spade", rank: 1 }])).toBeNull();
    expect(validateValue(hand, [{ suit: "spade", owner: undefined }])).toMatch(/\[0\]\.rank/);
  });

  it("Map・Set・Date・bigint・タプル・マップ", () => {
    const board: ValueSchema = { kind: "map", value: { kind: "list", item: num } };
    expect(validateValue(board, { a1: [1, 2], b2: [] })).toBeNull();
    expect(validateValue(board, { a1: ["x"] })).toMatch(/\["a1"\]\[0\]/);
    const scores: ValueSchema = { kind: "Map", key: entity, value: { kind: "bigint" } };
    expect(validateValue(scores, new Map([["e1", 3n]]))).toBeNull();
    expect(validateValue(scores, new Map([["e1", 3]]))).toMatch(/大きな整数/);
    expect(validateValue(scores, { e1: 3n })).toMatch(/Map ではありません/);
    expect(validateValue({ kind: "Set", item: str }, new Set(["a"]))).toBeNull();
    expect(validateValue({ kind: "Set", item: str }, new Set([1]))).toMatch(/文字ではありません/);
    expect(validateValue({ kind: "Date" }, new Date(0))).toBeNull();
    expect(validateValue({ kind: "Date" }, "2026-11-10")).toMatch(/日時/);
    const pair: ValueSchema = { kind: "tuple", items: [str, num] };
    expect(validateValue(pair, ["a", 1])).toBeNull();
    expect(validateValue(pair, ["a", 1, 2])).toMatch(/2 個の並び/);
    expect(validateValue({ kind: "color" }, "#A0b1C2")).toBeNull();
    expect(validateValue({ kind: "color" }, "red")).toMatch(/色/);
  });

  it("数は NaN・Infinity も受け入れる。有限に限ることもできる（Built-in）", () => {
    expect(validateValue(num, Number.NaN)).toBeNull();
    expect(validateValue(num, Number.POSITIVE_INFINITY)).toBeNull();
    expect(validateValue(num, Number.NaN, { finite: true })).toMatch(/有限の数/);
    const vec3 = knownSchema("Vec3") as ValueSchema;
    expect(validateValue(vec3, [0, Number.NaN, 0], { finite: true })).toMatch(/\[1\]/);
    expect(validateValue(vec3, [0, 1, 2], { finite: true })).toBeNull();
  });

  it("null は、どの型にも合わない", () => {
    for (const s of [num, str, undef, entity, hand, knownSchema("EntityRef | undefined")])
      expect(validateValue(s as ValueSchema, null)).not.toBeNull();
  });
});

describe("型の文から分かるスキーマ", () => {
  it("Tukurium が用意する型と、「なし」にできる形だけを読む", () => {
    expect(knownSchema("number")).toEqual(num);
    expect(knownSchema("  EntityRef |undefined ")).toEqual({
      kind: "union",
      options: [entity, undef],
    });
    expect(knownSchema("undefined | MaterialRef")).toEqual({
      kind: "union",
      options: [{ kind: "ref", target: "material" }, undef],
    });
    expect(isVec3Schema(knownSchema("Vec3") as ValueSchema)).toBe(true);
    for (const text of ["number[]", "Card", "undefined", "number | string", "", "constructor"])
      expect(knownSchema(text), text).toBeUndefined();
  });

  it("TypeScript で作ったスキーマがあれば、そちらを使う", () => {
    const field = { id: "f", type: "Card[]" };
    expect(schemaOfField(undefined, "ks", field)).toBeUndefined();
    expect(schemaOfField({ ks: { f: hand } }, "ks", field)).toBe(hand);
    expect(schemaOfField({}, "ks", { id: "f", type: "number" })).toEqual(num);
  });

  it("参照の指す先と、「なし」にできるか", () => {
    const optional = knownSchema("AudioRef | undefined") as ValueSchema;
    expect(refTargetOf(optional)).toBe("audio");
    expect(acceptsUndefined(optional)).toBe(true);
    expect(refTargetOf(entity)).toBe("entity");
    expect(acceptsUndefined(entity)).toBe(false);
    expect(refTargetOf(hand)).toBeUndefined();
    expect(hasRefs(hand)).toBe(true);
    expect(hasRefs({ kind: "list", item: num })).toBe(false);
  });
});

describe("入れ子の中の参照", () => {
  const value = () => [
    { suit: "spade", rank: 1, owner: "e1" },
    { suit: "heart", rank: 2, owner: undefined },
    { suit: "heart", rank: 3, owner: "e2" },
  ];

  it("スキーマに沿ってたどる", () => {
    const seen: string[] = [];
    visitRefs(hand, value(), (target, id) => seen.push(`${target}:${id}`));
    expect(seen).toEqual(["entity:e1", "entity:e2"]);
    const inMap: string[] = [];
    visitRefs(
      {
        kind: "Map",
        key: entity,
        value: { kind: "Set", item: { kind: "ref", target: "material" } },
      },
      new Map([["e9", new Set(["m1"])]]),
      (target, id) => inMap.push(`${target}:${id}`),
    );
    expect(inMap).toEqual(["entity:e9", "material:m1"]);
  });

  it("文字と参照が並ぶ型で、文字を参照と取り違えない", () => {
    const either: ValueSchema = {
      kind: "union",
      options: [{ kind: "literal", value: "none" }, entity],
    };
    const seen: string[] = [];
    visitRefs(either, "none", (_t, id) => seen.push(id));
    visitRefs(either, "e1", (_t, id) => seen.push(id));
    expect(seen).toEqual(["e1"]);
  });

  it("参照を置き換えた値を返す（元の値は変えない）", () => {
    const before = value();
    const after = mapRefs(hand, before, (_t, id) => (id === "e1" ? "x/e1" : undefined));
    expect(after).toEqual([
      { suit: "spade", rank: 1, owner: "x/e1" },
      { suit: "heart", rank: 2, owner: undefined },
      { suit: "heart", rank: 3, owner: "e2" },
    ]);
    expect(before).toEqual(value());
  });
});

describe("JSON だけで運べる型か（スクリプトとの受け渡し）", () => {
  it("有限の数・文字・真偽・色・必ず指す参照と、その並びやレコードは運べる", () => {
    expect(isJsonSafe(num, true)).toBe(true);
    expect(isJsonSafe(knownSchema("Vec3") as ValueSchema, true)).toBe(true);
    expect(
      isJsonSafe(
        {
          kind: "list",
          item: { kind: "record", fields: [{ name: "a", optional: true, schema: str }] },
        },
        true,
      ),
    ).toBe(true);
    expect(isJsonSafe(entity, false)).toBe(true);
  });

  it("NaN を持ちうる数・undefined・Date・Map・Set・bigint・文字のキーのマップは運べない", () => {
    expect(isJsonSafe(num, false)).toBe(false);
    expect(isJsonSafe(knownSchema("EntityRef | undefined") as ValueSchema, true)).toBe(false);
    expect(isJsonSafe({ kind: "Date" }, true)).toBe(false);
    expect(isJsonSafe({ kind: "map", value: str }, true)).toBe(false);
    expect(
      isJsonSafe({ kind: "record", fields: [{ name: "$t", optional: false, schema: str }] }, true),
    ).toBe(false);
    expect(isJsonSafe(hand, true)).toBe(false);
  });
});
