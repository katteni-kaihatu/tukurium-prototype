import { describe, expect, it } from "vitest";
import {
  cloneValue,
  decodeValue,
  encodeValue,
  equalValues,
  hasTag,
  parseValue,
  stringifyValue,
  VALUE_CODEC_SOURCE,
} from "./value";

/** JSON で表せない値をひととおり入れた値（ADR 0065） */
const rich = () => ({
  none: undefined,
  nan: Number.NaN,
  inf: Number.POSITIVE_INFINITY,
  ninf: Number.NEGATIVE_INFINITY,
  big: 12345678901234567890n,
  at: new Date("2026-11-10T00:00:00.000Z"),
  board: new Map<unknown, unknown>([
    ["a1", { kind: "pawn", moved: undefined }],
    [7, [1, undefined, 3]],
  ]),
  tags: new Set<unknown>(["x", 2n, new Date(0)]),
  list: [undefined, null, 0, "", false, [new Set([1])]],
  tagged: { $t: "これはふつうのオブジェクト", v: 1 },
  plain: { a: 1, b: "two", c: [true, null] },
});

describe("値の書き出しと読み込み（ADR 0065）", () => {
  it("ふつうの JSON は、そのままの形で書き出す", () => {
    const v = { a: 1, b: "two", c: [true, null, { d: 0.5 }] };
    expect(encodeValue(v)).toEqual(v);
    expect(stringifyValue(v)).toBe(JSON.stringify(v));
  });

  it("JSON で表せない値を、タグ付きのオブジェクトにする", () => {
    expect(encodeValue(undefined)).toEqual({ $t: "undefined" });
    expect(encodeValue(Number.NaN)).toEqual({ $t: "number", v: "NaN" });
    expect(encodeValue(Number.POSITIVE_INFINITY)).toEqual({ $t: "number", v: "Infinity" });
    expect(encodeValue(Number.NEGATIVE_INFINITY)).toEqual({ $t: "number", v: "-Infinity" });
    expect(encodeValue(12345678901234567890n)).toEqual({
      $t: "bigint",
      v: "12345678901234567890",
    });
    expect(encodeValue(new Date("2026-11-10T00:00:00.000Z"))).toEqual({
      $t: "Date",
      v: "2026-11-10T00:00:00.000Z",
    });
    expect(encodeValue(new Map<unknown, unknown>([[1, "a"]]))).toEqual({
      $t: "Map",
      v: [[1, "a"]],
    });
    expect(encodeValue(new Set(["a", undefined]))).toEqual({
      $t: "Set",
      v: ["a", { $t: "undefined" }],
    });
    expect(encodeValue({ $t: "x", v: 1 })).toEqual({ $t: "object", v: { $t: "x", v: 1 } });
  });

  it("書き出して読み込むと、元どおりに戻る", () => {
    const back = parseValue(stringifyValue(rich())) as ReturnType<typeof rich>;
    expect(back).toEqual(rich());
    // toEqual は undefined のキーと「キーなし」を区別しないので、キーが残ることも確かめる
    expect("none" in back).toBe(true);
    expect(back.list).toHaveLength(6);
    expect(back.list[0]).toBeUndefined();
    expect(Number.isNaN(back.nan)).toBe(true);
    expect(back.big).toBe(12345678901234567890n);
    expect(back.at).toBeInstanceOf(Date);
    expect(back.board).toBeInstanceOf(Map);
    expect([...back.board.keys()]).toEqual(["a1", 7]);
    expect(back.tags.has(2n)).toBe(true);
    expect(back.tagged).toEqual({ $t: "これはふつうのオブジェクト", v: 1 });
  });

  it("書き出した形は、ふつうの JSON になる（JSON.stringify で欠けない）", () => {
    const encoded = encodeValue(rich());
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
  });

  it("壊れた日時は、壊れた日時として戻る", () => {
    const back = decodeValue(encodeValue(new Date(Number.NaN))) as Date;
    expect(back).toBeInstanceOf(Date);
    expect(Number.isNaN(back.getTime())).toBe(true);
  });

  it("toJSON() を持つオブジェクトは、その結果を書き出す（JSON と同じ）", () => {
    const koko = { id: "ks_1", name: "Gun", toJSON: () => "ks_1" };
    expect(encodeValue([koko])).toEqual(["ks_1"]);
  });

  it("関数は書き出さない（JSON と同じ）", () => {
    expect(encodeValue({ a: 1, f: () => 1 })).toEqual({ a: 1 });
    expect(encodeValue([() => 1])).toEqual([null]);
  });

  it("形式に合わないタグは、読み込みで TypeError にする", () => {
    expect(() => decodeValue({ $t: "Function", v: "x" })).toThrow(TypeError);
    expect(() => decodeValue({ $t: "Map", v: "x" })).toThrow(TypeError);
    expect(() => decodeValue({ $t: "Map", v: [[1]] })).toThrow(TypeError);
    expect(() => decodeValue({ $t: "bigint", v: "1e3" })).toThrow(TypeError);
    expect(() => decodeValue({ $t: "number", v: "1" })).toThrow(TypeError);
    expect(() => decodeValue({ $t: "bigint", v: "9".repeat(5000) })).toThrow(TypeError);
  });

  it('"__proto__" のキーを、原型の差し替えにしない', () => {
    const back = parseValue('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>;
    expect(Object.keys(back).sort()).toEqual(["__proto__", "a"]);
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(encodeValue(back))).toBe('{"__proto__":{"polluted":true},"a":1}');
  });
});

describe("書き出しの細かい決まり", () => {
  class Card {
    constructor(
      readonly suit: string,
      readonly joker?: boolean,
    ) {}
  }
  const cases: [string, unknown][] = [
    ["値そのもの", undefined],
    ["壊れた日時", new Date(Number.NaN)],
    ["クラスのインスタンス", [new Card("spade"), new Card("heart", undefined)]],
    ["toJSON がタグになる値を返す", [{ toJSON: () => new Map([[1, Number.NaN]]) }]],
    ['"$t" を持つオブジェクトの入れ子', { $t: "Date", v: { $t: "object", v: { $t: undefined } } }],
    ["Map の中", new Map<unknown, unknown>([[{ $t: 1 }, new Set([undefined, { $t: 2 }])]])],
    // biome-ignore lint/suspicious/noSparseArray: 穴のある配列も、undefined として運ぶ
    ["穴のある配列", [1, , 3]],
  ];

  it.each(cases)(
    "書き出した形はふつうの JSON で、読み込むと同じ形に書き出せる：%s",
    (_name, value) => {
      const json = encodeValue(value);
      expect(JSON.parse(JSON.stringify(json))).toEqual(json);
      expect(encodeValue(decodeValue(json))).toEqual(json);
    },
  );

  it("大きすぎる bigint は断る", () => {
    expect(() => encodeValue(10n ** 5000n)).toThrow(RangeError);
  });

  it("タグがあるかを調べられる", () => {
    expect(hasTag({ a: [1, { b: "x" }], c: null })).toBe(false);
    expect(hasTag(encodeValue({ a: [1, { b: undefined }] }))).toBe(true);
    expect(hasTag(encodeValue([new Set()]))).toBe(true);
    expect(hasTag(encodeValue(Number.NaN))).toBe(true);
  });
});

describe("QuickJS に入れる文（VALUE_CODEC_SOURCE）", () => {
  it("文だけで動く（外の変数を使っていない）", () => {
    // モジュールの変数が見えない所（グローバル）で、文だけを動かす
    const run = new Function(`return (${VALUE_CODEC_SOURCE})();`) as () => {
      encode(v: unknown): unknown;
      decode(v: unknown): unknown;
    };
    const codec = run();
    expect(codec.decode(codec.encode(rich()))).toEqual(rich());
  });

  it("中に、名前の付く関数を書いていない（tsx の keepNames が __name() で包み、QuickJS で落ちる）", () => {
    const body = VALUE_CODEC_SOURCE.slice(VALUE_CODEC_SOURCE.indexOf("{"));
    expect(body).not.toContain("__name");
    // const f = (...) => / const f = x => / const f = function / function f( / class F
    expect(body).not.toMatch(/\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/);
    expect(body).not.toMatch(/\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?function\b/);
    expect(body).not.toMatch(/\bfunction\s+\w+\s*\(/);
    expect(body).not.toMatch(/\bclass\s+\w+/);
  });
});

describe("値の複製と比べ方", () => {
  it("入れ子の中まで複製する", () => {
    const a = rich();
    const b = cloneValue(a);
    expect(b).toEqual(a);
    expect(b.board).not.toBe(a.board);
    expect(b.board.get("a1")).not.toBe(a.board.get("a1"));
    expect(b.at).not.toBe(a.at);
    expect(b.list[5]).not.toBe(a.list[5]);
    expect("none" in b).toBe(true);
  });

  it("広げた値どうしを比べられる", () => {
    expect(equalValues(rich(), rich())).toBe(true);
    expect(equalValues(Number.NaN, Number.NaN)).toBe(true);
    expect(equalValues({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(equalValues(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(equalValues(new Set([1, 2]), new Set([1, 3]))).toBe(false);
    expect(equalValues(new Date(1), new Date(2))).toBe(false);
    expect(equalValues(1n, 1)).toBe(false);
    expect(equalValues(undefined, null)).toBe(false);
    expect(equalValues({ a: undefined }, {})).toBe(false);
    expect(equalValues([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(equalValues(new Map(), {})).toBe(false);
  });
});
