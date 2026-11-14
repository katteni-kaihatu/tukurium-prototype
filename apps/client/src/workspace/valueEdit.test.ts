import type { FieldSchemas, KokoStateDef, ValueSchema } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import {
  countLabel,
  fieldChoices,
  fillValue,
  isInlineSchema,
  moveItem,
  newKey,
  optionIndex,
  parseTypedText,
  renameKey,
  schemaLabel,
  shapeMatches,
  stateRefOf,
  withoutKey,
  withoutUndefined,
} from "./valueEdit";

const NUMBER: ValueSchema = { kind: "number" };
const STRING: ValueSchema = { kind: "string" };
const UNDEFINED: ValueSchema = { kind: "undefined" };
const card: ValueSchema = {
  kind: "record",
  fields: [
    { name: "suit", optional: false, schema: STRING },
    { name: "rank", optional: false, schema: NUMBER },
    { name: "note", optional: true, schema: STRING },
  ],
};
const hand: ValueSchema = { kind: "list", item: card };
const maybe = (schema: ValueSchema): ValueSchema => ({
  kind: "union",
  options: [schema, UNDEFINED],
});

describe("入れ子の値を直す（ADR 0065）", () => {
  it("1 行で直せる型と、枠を開いて直す型を分ける", () => {
    expect(isInlineSchema(NUMBER)).toBe(true);
    expect(isInlineSchema({ kind: "tuple", items: [NUMBER, NUMBER, NUMBER] })).toBe(true);
    expect(isInlineSchema({ kind: "tuple", items: [NUMBER, STRING] })).toBe(false);
    expect(isInlineSchema(maybe({ kind: "ref", target: "entity" }))).toBe(true);
    expect(isInlineSchema(maybe({ kind: "fieldRef", value: NUMBER }))).toBe(true);
    expect(isInlineSchema(hand)).toBe(false);
    expect(isInlineSchema(maybe(card))).toBe(false);
    expect(isInlineSchema({ kind: "map", value: NUMBER })).toBe(false);
    expect(isInlineSchema({ kind: "Set", item: NUMBER })).toBe(false);
  });

  it("値の大枠が型に合うかを見る（中身の直し残しは、その型の入力で直す）", () => {
    expect(shapeMatches(hand, [])).toBe(true);
    expect(shapeMatches(hand, [{ suit: 1 }])).toBe(true);
    expect(shapeMatches(hand, 0)).toBe(false);
    expect(shapeMatches(card, {})).toBe(true);
    expect(shapeMatches(card, [])).toBe(false);
    expect(shapeMatches(NUMBER, "1")).toBe(false);
    expect(shapeMatches({ kind: "tuple", items: [NUMBER, NUMBER] }, [1])).toBe(false);
    // 指せない KokoState を指している参照も、選び直せるように入力へ渡す
    expect(shapeMatches({ kind: "kokoRef", koko: "ks_a" }, { entity: "e", koko: "ks_b" })).toBe(
      true,
    );
    expect(shapeMatches({ kind: "kokoRef", koko: "ks_a" }, "e")).toBe(false);
    expect(shapeMatches(maybe(card), undefined)).toBe(true);
    expect(shapeMatches(maybe(card), 3)).toBe(false);
  });

  it("値が当たる選択肢を選ぶ（中身まで合うものが先、なければ大枠が合うもの）", () => {
    const either: ValueSchema & { kind: "union" } = {
      kind: "union",
      options: [NUMBER, card, hand, UNDEFINED],
    };
    expect(optionIndex(either, 1)).toBe(0);
    expect(optionIndex(either, { suit: "♠", rank: 1 })).toBe(1);
    expect(optionIndex(either, { suit: "♠" })).toBe(1);
    expect(optionIndex(either, [])).toBe(2);
    expect(optionIndex(either, undefined)).toBe(3);
    expect(optionIndex(either, "x")).toBe(-1);
  });

  it("足すときの値は、「なし」にできる型でも中身のある空の値にする", () => {
    expect(withoutUndefined(maybe(NUMBER))).toEqual(NUMBER);
    expect(withoutUndefined(NUMBER)).toEqual(NUMBER);
    expect(withoutUndefined(UNDEFINED)).toEqual(UNDEFINED);
    expect(fillValue(maybe(NUMBER))).toBe(0);
    // 省略できるフィールドは、足すまで入れない
    expect(fillValue(card)).toEqual({ suit: "", rank: 0 });
    expect(fillValue(hand)).toEqual([]);
  });

  it("KokoState の参照・フィールドの参照と、「なし」にできるかを読む", () => {
    const hp: ValueSchema = { kind: "fieldRef", value: NUMBER };
    expect(stateRefOf(hp)).toEqual({ ref: hp, optional: false });
    expect(stateRefOf(maybe(hp))).toEqual({ ref: hp, optional: true });
    expect(stateRefOf(maybe({ kind: "kokoRef", koko: "ks" }))?.optional).toBe(true);
    expect(stateRefOf(maybe(NUMBER))).toBeUndefined();
    expect(stateRefOf({ kind: "union", options: [hp, STRING] })).toBeUndefined();
  });

  it("型を短い文字で表す", () => {
    expect(schemaLabel(maybe(NUMBER))).toBe("Number | （なし）");
    expect(schemaLabel(card)).toBe("{ suit, rank, note }");
    expect(schemaLabel({ kind: "literal", value: "♠" })).toBe("♠");
    expect(schemaLabel({ kind: "tuple", items: [NUMBER, NUMBER, NUMBER] })).toBe("Vector3");
    expect(countLabel(hand, [1, 2])).toBe("2 件");
    expect(countLabel({ kind: "map", value: NUMBER }, { a: 1 })).toBe("1 件");
    expect(countLabel(card, {})).toBe("");
  });

  it("並びの中の一つを動かす（元の並びは書き換えない）", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(list, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(list, 0, -1)).toEqual(list);
    expect(moveItem(list, 2, 3)).toEqual(list);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("マップのキーを変える・足す・消す（並びはそのまま。すでにあるキーには変えられない）", () => {
    const board = { a1: "rook", b1: "knight", c1: "bishop" };
    const renamed = renameKey(board, "b1", "b3");
    expect(renamed).toEqual({ a1: "rook", b3: "knight", c1: "bishop" });
    expect(Object.keys(renamed ?? {})).toEqual(["a1", "b3", "c1"]);
    expect(renameKey(board, "b1", "a1")).toBeNull();
    expect(renameKey(board, "b1", "")).toBeNull();
    expect(renameKey(board, "b1", "b1")).toBe(board);
    expect(withoutKey(board, "a1")).toEqual({ b1: "knight", c1: "bishop" });
    expect(newKey({})).toBe("key");
    expect(newKey({ key: 1, key2: 2 })).toBe("key3");
    expect(board).toEqual({ a1: "rook", b1: "knight", c1: "bishop" });
  });

  it("値の形式の文字を読み、型に合わないものは理由を返す", () => {
    const tags: ValueSchema = { kind: "Set", item: STRING };
    expect(parseTypedText('{"$t":"Set","v":["a","b"]}', tags)).toEqual({
      ok: true,
      value: new Set(["a", "b"]),
    });
    const bad = parseTypedText('{"$t":"Set","v":["a",1]}', tags);
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.error).toMatch(/型に合いません/);
    const broken = parseTypedText("[1,", hand);
    expect(broken.ok ? "" : broken.error).toMatch(/値の形式として読めません/);
    // 型が分からないフィールドは、読めればそのまま入れる
    expect(parseTypedText("[1]", undefined)).toEqual({ ok: true, value: [1] });
  });

  it("フィールドの参照で選べるのは、型で指せるフィールドだけ（数の参照で、文字のフィールドは選べない）", () => {
    const defs: KokoStateDef[] = [
      {
        id: "ks_health",
        name: "Health",
        fields: [
          { id: "f_hp", name: "hp", type: "number", default: 3 },
          { id: "f_label", name: "label", type: "string", default: "" },
          { id: "f_cards", name: "cards", type: "Card[]", default: [] },
        ],
      },
      {
        id: "ks_score",
        name: "Score",
        fields: [{ id: "f_n", name: "n", type: "number", default: 0 }],
      },
    ];
    const defOf = (id: string) => defs.find((d) => d.id === id);
    const schemas: FieldSchemas = { ks_health: { f_cards: hand } };
    const names = (attached: string[], want?: ValueSchema) =>
      fieldChoices(attached, defOf, schemas, want).map((c) => c.label);

    expect(names(["ks_health", "ks_score"], NUMBER)).toEqual(["Health.hp", "Score.n"]);
    expect(names(["ks_health"], STRING)).toEqual(["Health.label"]);
    expect(names(["ks_health"], hand)).toEqual(["Health.cards"]);
    // 型を決めていない参照は、どのフィールドも指せる
    expect(names(["ks_health"])).toEqual(["Health.hp", "Health.label", "Health.cards"]);
    // 付いていない KokoState・ない KokoState のフィールドは出ない
    expect(names(["ks_score", "ks_gone"], NUMBER)).toEqual(["Score.n"]);
    expect(fieldChoices(["ks_score"], defOf, schemas, NUMBER)[0]).toEqual({
      koko: "ks_score",
      field: "f_n",
      label: "Score.n",
    });
  });
});
