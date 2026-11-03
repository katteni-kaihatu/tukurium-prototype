import { describe, expect, it } from "vitest";
import { emptyProject, gunAndTargetSample, gunSample, targetRangeSample } from "../samples";
import { checkProjectReferences } from "./references";
import { checkProjectStructure } from "./structure";

describe("サンプルの制作データ", () => {
  it.each([
    ["空", emptyProject("p")],
    ["銃と的", gunAndTargetSample()],
    ["銃", gunSample()],
    ["射撃場", targetRangeSample()],
  ])("%s には問題が出ない", (_, snap) => {
    expect([...checkProjectStructure(snap), ...checkProjectReferences(snap)]).toEqual([]);
  });
});
