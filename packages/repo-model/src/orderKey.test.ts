import { describe, expect, it } from "vitest";
import { assignOrderKeys, orderKeyBetween } from "./orderKey";

const sorted = (keys: string[]) => [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe("並べ替え用のキー（ADR 0065）", () => {
  it("2 つのキーの間に、いつでも新しいキーを作れる", () => {
    let low = orderKeyBetween(null, null);
    let high = orderKeyBetween(low, null);
    expect(low < high).toBe(true);
    // 同じ所に何度も入れても、間のキーが尽きない
    for (let i = 0; i < 200; i++) {
      const mid = orderKeyBetween(low, high);
      expect(low < mid && mid < high, `${low} < ${mid} < ${high}`).toBe(true);
      if (i % 2 === 0) low = mid;
      else high = mid;
    }
    // 先頭と末尾にも足せる
    let first = orderKeyBetween(null, low);
    let last = orderKeyBetween(high, null);
    for (let i = 0; i < 100; i++) {
      const before = orderKeyBetween(null, first);
      const after = orderKeyBetween(last, null);
      expect(before < first && last < after).toBe(true);
      first = before;
      last = after;
    }
  });

  it("新しい並びには、小さい順のキーを作る", () => {
    const keys = assignOrderKeys([undefined, undefined, undefined, undefined]);
    expect(new Set(keys).size).toBe(4);
    expect(sorted(keys)).toEqual(keys);
  });

  it("足した所・動かした所にだけ、新しいキーを作る", () => {
    const [a, b, c, d] = assignOrderKeys([undefined, undefined, undefined, undefined]);
    // 間に足す
    const inserted = assignOrderKeys([a, undefined, b, c, d]);
    expect([inserted[0], inserted[2], inserted[3], inserted[4]]).toEqual([a, b, c, d]);
    expect(sorted(inserted)).toEqual(inserted);
    // 後ろの d を先頭へ動かす：ほかの 3 つのキーはそのまま
    const moved = assignOrderKeys([d, a, b, c]);
    expect(moved.slice(1)).toEqual([a, b, c]);
    expect(sorted(moved)).toEqual(moved);
    // 先頭の a を後ろへ動かす
    const toLast = assignOrderKeys([b, c, d, a]);
    expect(toLast.slice(0, 3)).toEqual([b, c, d]);
    expect(sorted(toLast)).toEqual(toLast);
  });

  it("同じキーや、形のおかしいキーがあっても、小さい順のキーにそろえる", () => {
    const keys = assignOrderKeys(["V", "V", "", "0", "k"]);
    expect(new Set(keys).size).toBe(5);
    expect(sorted(keys)).toEqual(keys);
    expect(keys[0]).toBe("V");
    expect(keys[4]).toBe("k");
  });
});
