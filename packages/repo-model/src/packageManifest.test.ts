import { describe, expect, it } from "vitest";
import { fromFiles, toFiles } from "./files";
import { packageManifest, stableStringify } from "./packageManifest";
import { ProjectDoc } from "./projectDoc";
import { gunAndTargetSample } from "./samples";

describe("公開の印（exports。ADR 0015）", () => {
  it("印を付けたリソースだけが制作データの exports に入り、消したリソースは残らない", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    p.setExported("ks_gun", true);
    p.setExported("sys_shoot", true);
    p.setExported("sys_shoot", false);
    p.setExported("ks_target", true);
    expect(p.isExported("ks_gun")).toBe(true);
    expect(p.snapshot().exports).toEqual(["ks_gun", "ks_target"]);
    p.removeKokoState("ks_target");
    expect(p.snapshot().exports).toEqual(["ks_gun"]);
  });

  it("ファイルに書き出して読み戻しても残る", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    p.setExported("ks_gun", true);
    const back = fromFiles(toFiles(p.snapshot()));
    expect(back.exports).toEqual(["ks_gun"]);
  });
});

describe("packageManifest（Registry が hash を計算する正本の並び）", () => {
  it("公開したものだけを、ID の順に、論理パスと定義つきで並べる", () => {
    const s = gunAndTargetSample();
    s.exports = ["sys_shoot", "ks_gun"];
    const m = packageManifest(s);
    expect(m.exports.map((e) => [e.kind, e.id, e.path])).toEqual([
      ["kokostate", "ks_gun", "/Gun.koko"],
      ["system", "sys_shoot", "/Shoot.system"],
    ]);
    expect(m.exports[1]?.definition).toMatchObject({
      name: "Shoot",
      code: expect.stringContaining("export default"),
    });
  });

  it("公開していないものの変更では、manifest の文字列は変わらない", () => {
    const a = gunAndTargetSample();
    a.exports = ["ks_gun"];
    const b = gunAndTargetSample();
    b.exports = ["ks_gun"];
    b.materials = b.materials.map((m) => ({ ...m, color: "#000000" }));
    expect(stableStringify(packageManifest(a))).toBe(stableStringify(packageManifest(b)));
  });

  it("stableStringify はキーの順に左右されない", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
