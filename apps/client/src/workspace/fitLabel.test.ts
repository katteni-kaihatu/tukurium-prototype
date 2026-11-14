import { describe, expect, it } from "vitest";
import { LABEL_FONT_MAX, labelFontSize } from "./fitLabel";

describe("欄の名前の文字の大きさ", () => {
  it("枠に入るときは縮めない", () => {
    expect(labelFontSize(80, 120)).toBeNull();
    expect(labelFontSize(120, 120)).toBeNull();
  });

  it("はみ出すときは、全部入る大きさに縮める", () => {
    const size = labelFontSize(240, 120);
    expect(size).toBeCloseTo((LABEL_FONT_MAX * 120) / 240);
    expect(size).toBeLessThan(LABEL_FONT_MAX);
  });

  it("幅が無いときは何もしない", () => {
    expect(labelFontSize(80, 0)).toBeNull();
  });
});
