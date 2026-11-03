import { describe, expect, it } from "vitest";
import { HOST_API_ARGS, parseHostArgs } from "./hostApi";
import { HOST_API } from "./simulation";

describe("Host API の引数の検証（schema-first）", () => {
  it("すべての Host API に引数の定義がある", () => {
    expect(Object.keys(HOST_API_ARGS).sort()).toEqual([...HOST_API].sort());
  });

  it("座標・Entity の ID・イベント名の誤りは、利用者向けの文言で例外にする", () => {
    expect(() =>
      parseHostArgs("world.raycast", [
        [0, 1],
        [0, 0, -1],
      ]),
    ).toThrow("[x, y, z] の形の数値の配列を渡してください");
    expect(() => parseHostArgs("world.emit", [1, "hit"])).toThrow(
      "Entity の ID（文字列）を渡してください",
    );
    expect(() => parseHostArgs("world.emit", ["e", 3])).toThrow(
      "イベント名（文字列）を渡してください",
    );
  });

  it("今まで黙って無視していた引数は「無いもの」にする（後ろの引数は省略できる）", () => {
    expect(parseHostArgs("world.raycast", [[0, 0, 0], [0, 0, -1], "far", 5])).toEqual([
      [0, 0, 0],
      [0, 0, -1],
      undefined,
      undefined,
    ]);
    const [id, koko] = parseHostArgs("world.get", [3]);
    expect([id, koko]).toEqual([undefined, undefined]);
    expect(parseHostArgs("world.spawn", [])[0]).toBeUndefined();
    expect(parseHostArgs("world.spawn", [{ name: "a", parent: 1 }])).toEqual([
      { name: "a", parent: undefined, states: undefined },
    ]);
  });
});
