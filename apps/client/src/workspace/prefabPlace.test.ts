import { describe, expect, it } from "vitest";
import { type Box, boxesOverlap, moveBox, PREFAB_EDIT_GAP, prefabEditOrigin } from "./prefabPlace";

const box = (min: [number, number, number], max: [number, number, number]): Box => ({ min, max });

describe("プレハブを「その場」で編集するときの置き場所", () => {
  // 的：原点を中心にした 1 m の箱と、上に載った芯
  const content = box([-0.5, -0.5, -0.5], [0.5, 1.2, 0.5]);

  it("インスタンスから開くと、そのインスタンスと重ならない横に出す", () => {
    // インスタンスは、[3, 1, -2] に置いてある（大きさは 2 倍）
    const instance = box([2, 0, -3], [4, 3.4, -1]);
    const origin = prefabEditOrigin({ content, instance, output: instance });
    const placed = moveBox(content, origin);
    expect(boxesOverlap(placed, instance)).toBe(false);
    // すき間をあけて、すぐ横（+X 側）。高さと奥行きは、インスタンスに合わせる
    expect(placed.min[0]).toBeCloseTo(instance.max[0] + PREFAB_EDIT_GAP);
    expect(placed.min[1]).toBeCloseTo(instance.min[1]);
    expect((placed.min[2] + placed.max[2]) / 2).toBeCloseTo(-2);
  });

  it("同じ大きさのインスタンスなら、原点は、インスタンスの原点を横にずらした所になる", () => {
    const at: [number, number, number] = [3, 1, -2];
    const instance = moveBox(content, at);
    expect(prefabEditOrigin({ content, instance, output: instance })).toEqual([
      3 + 1 + PREFAB_EDIT_GAP,
      1,
      -2,
    ]);
  });

  it("横にほかの物があれば、それとも重ならない所まで送る", () => {
    const instance = moveBox(content, [0, 0.5, 0]);
    // 的が、1.2 m おきに 3 つ並んでいる。真ん中から開く
    const right = moveBox(content, [1.2, 0.5, 0]);
    const farRight = moveBox(content, [2.4, 0.5, 0]);
    const left = moveBox(content, [-1.2, 0.5, 0]);
    const obstacles = [left, farRight, right];
    const placed = moveBox(
      content,
      prefabEditOrigin({ content, instance, output: instance, obstacles }),
    );
    for (const other of [instance, ...obstacles]) expect(boxesOverlap(placed, other)).toBe(false);
    expect(placed.min[0]).toBeCloseTo(farRight.max[0] + PREFAB_EDIT_GAP);
  });

  it("奥や上にずれていて重ならない物は、よけない", () => {
    const instance = moveBox(content, [0, 0.5, 0]);
    const behind = moveBox(content, [1.5, 0.5, -5]);
    const origin = prefabEditOrigin({ content, instance, output: instance, obstacles: [behind] });
    expect(origin[0]).toBeCloseTo(instance.max[0] + PREFAB_EDIT_GAP + 0.5);
  });

  it("Resources から開くと、区画に出ているもの全体の手前に、床に載せて出す", () => {
    const output = box([-2, 0, -3], [4, 2, 1]);
    const origin = prefabEditOrigin({ content, instance: null, output });
    const placed = moveBox(content, origin);
    expect(boxesOverlap(placed, output)).toBe(false);
    expect(placed.min[2]).toBeCloseTo(output.max[2] + PREFAB_EDIT_GAP);
    // 横は区画の真ん中、底は床
    expect((placed.min[0] + placed.max[0]) / 2).toBeCloseTo(1);
    expect(placed.min[1]).toBeCloseTo(0);
  });

  it("アウトプットが空でも、中身のないプレハブでも、置き場所が決まる", () => {
    expect(prefabEditOrigin({ content, instance: null, output: null })).toEqual([
      0,
      0.5,
      PREFAB_EDIT_GAP + 0.5,
    ]);
    expect(prefabEditOrigin({ content: null, instance: null, output: null })).toEqual([
      0,
      0,
      PREFAB_EDIT_GAP,
    ]);
    const instance = box([1, 0, 1], [2, 1, 2]);
    expect(prefabEditOrigin({ content: null, instance, output: instance })).toEqual([
      2 + PREFAB_EDIT_GAP,
      0,
      1.5,
    ]);
  });
});
