import { describe, expect, it } from "vitest";
import {
  clampDetailsWidth,
  DETAILS_DEFAULT,
  DETAILS_MAX,
  DETAILS_MIN,
  detailsWidthBounds,
  fieldLabelWidth,
  HIERARCHY_MIN,
} from "./inspectorLayout";

describe("詳細の幅", () => {
  it("既定の 380px は、いつものパネル幅ではそのまま", () => {
    expect(clampDetailsWidth(DETAILS_DEFAULT, 600)).toBe(380);
  });

  it("広げても階層の幅を残し、上限を超えない", () => {
    expect(clampDetailsWidth(500, 600)).toBe(600 - HIERARCHY_MIN);
    expect(clampDetailsWidth(2000, 2000)).toBe(DETAILS_MAX);
  });

  it("パネルが狭いときは詳細も縮み、階層が消えない", () => {
    const width = clampDetailsWidth(380, 400);
    expect(width).toBe(400 - HIERARCHY_MIN);
    expect(detailsWidthBounds(400).min).toBeLessThanOrEqual(width);
  });

  it("パネル幅がまだ無いときは、決めた下限と上限に収める", () => {
    expect(clampDetailsWidth(10, 0)).toBe(DETAILS_MIN);
    expect(clampDetailsWidth(9999, 0)).toBe(DETAILS_MAX);
    expect(clampDetailsWidth(Number.NaN, 600)).toBe(DETAILS_DEFAULT);
  });
});

describe("欄の名前の幅", () => {
  it("380px のとき 104px で、どの欄も同じ", () => {
    expect(fieldLabelWidth(380)).toBe(104);
    expect(fieldLabelWidth(380)).toBe(fieldLabelWidth(380));
  });

  it("詳細を広げると名前の幅も増える", () => {
    expect(fieldLabelWidth(500)).toBeGreaterThan(fieldLabelWidth(380));
    expect(fieldLabelWidth(700)).toBeGreaterThan(fieldLabelWidth(500));
  });

  it("際限なく広がらず、狭くしても数値の場所を残す", () => {
    expect(fieldLabelWidth(2000)).toBe(200);
    expect(fieldLabelWidth(340)).toBeLessThan(fieldLabelWidth(380));
    expect(fieldLabelWidth(200)).toBe(64);
  });
});
