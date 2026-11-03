import { describe, expect, it } from "vitest";
import { BUILTIN } from "../builtins";
import { forestSample } from "../forestSample";
import { marubatsuSample } from "../marubatsuSample";
import { ResourcePathIndex } from "../resourcePath";
import { emptyProject, gunAndTargetSample, gunSample, targetRangeSample } from "../samples";
import { compileSystem } from "../systemCompiler";
import { checkProjectReferences } from "./references";
import { checkProjectStructure } from "./structure";

describe("サンプルの制作データ", () => {
  it.each([
    ["空", emptyProject("p")],
    ["銃と的", gunAndTargetSample()],
    ["銃", gunSample()],
    ["射撃場", targetRangeSample()],
    ["森", forestSample()],
    ["マルバツ", marubatsuSample()],
  ])("%s には問題が出ない", (_, snap) => {
    expect([...checkProjectStructure(snap), ...checkProjectReferences(snap)]).toEqual([]);
  });

  it("森は立ち位置のまわりを空けたワールドで、木のモデルを指している", () => {
    const snap = forestSample();
    expect(snap.outputs[0]?.kind).toBe("world");
    const assets = new Set((snap.assets ?? []).map((a) => a.id));
    const trees = snap.entities.filter((e) => {
      const model = e.states[BUILTIN.Mesh]?.model;
      return typeof model === "string" && model.length > 0;
    });
    expect(trees.length).toBeGreaterThanOrEqual(24);
    for (const tree of trees) {
      const model = tree.states[BUILTIN.Mesh]?.model;
      expect(assets.has(String(model))).toBe(true);
      const pos = tree.states[BUILTIN.Transform]?.position;
      if (!Array.isArray(pos)) throw new Error("木に位置がありません");
      const dx = Number(pos[0]);
      const dz = Number(pos[2]) - 6;
      expect(dx * dx + dz * dz).toBeGreaterThanOrEqual(4.5 ** 2);
    }
  });

  it("マルバツのスクリプトは問題なく読み込める", () => {
    const snap = marubatsuSample();
    const index = ResourcePathIndex.fromSnapshot(snap);
    for (const sys of snap.systems) {
      const compiled = compileSystem(sys.id, sys.code, index);
      expect(compiled.diagnostics, sys.name).toEqual([]);
      expect(compiled.ok, sys.name).toBe(true);
    }
    expect(snap.outputs[0]?.kind).toBe("item");
  });
});
