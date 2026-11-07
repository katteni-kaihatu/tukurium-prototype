import { describe, expect, it } from "vitest";
import { fromFiles, toFiles } from "./files";
import { packageManifest, stableStringify } from "./packageManifest";
import { ProjectDoc } from "./projectDoc";
import { gunAndTargetSample } from "./samples";
import type { ProjectSnapshot } from "./schema";

/** s にライブラリのアウトプット（out_lib）を足し、resources を含める */
function asLibrary(s: ProjectSnapshot, resources: string[]): ProjectSnapshot {
  s.outputs.push({ id: "out_lib", name: "lib", kind: "library", systems: [], keep: [], resources });
  return s;
}

describe("ライブラリに含めるリソース（ADR 0015・0055）", () => {
  it("含める・外すができ、消したリソースは制作データに残らない", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    const lib = p.addOutput("lib", "library");
    p.setIncluded(lib, "ks_gun", true);
    p.setIncluded(lib, "sys_shoot", true);
    p.setIncluded(lib, "sys_shoot", false);
    p.setIncluded(lib, "ks_target", true);
    const resources = (snap: ProjectSnapshot) => snap.outputs.find((o) => o.id === lib)?.resources;
    expect(resources(p.snapshot())).toEqual(["ks_gun", "ks_target"]);
    p.removeKokoState("ks_target");
    expect(resources(p.snapshot())).toEqual(["ks_gun"]);
  });

  it("ライブラリでないアウトプットには含められない", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    p.setIncluded("out_range", "ks_gun", true);
    expect(p.output("out_range")?.resources).toBeUndefined();
  });

  it("ライブラリには Entity を作れない", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    const lib = p.addOutput("lib", "library");
    expect(() => p.addEntity({ output: lib, name: "x" })).toThrow();
  });

  it("ファイルに書き出して読み戻しても残る", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    const lib = p.addOutput("lib", "library");
    p.setIncluded(lib, "ks_gun", true);
    const back = fromFiles(toFiles(p.snapshot()));
    expect(back.outputs.find((o) => o.id === lib)?.resources).toEqual(["ks_gun"]);
  });
});

describe("packageManifest（Registry が hash を計算する正本の並び）", () => {
  it("公開したものだけを、ID の順に、論理パスと定義つきで並べる", () => {
    const s = asLibrary(gunAndTargetSample(), ["sys_shoot", "ks_gun"]);
    const m = packageManifest(s, "out_lib");
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
    const a = asLibrary(gunAndTargetSample(), ["ks_gun"]);
    const b = asLibrary(gunAndTargetSample(), ["ks_gun"]);
    b.materials = b.materials.map((m) => ({ ...m, color: "#000000" }));
    expect(stableStringify(packageManifest(a, "out_lib"))).toBe(
      stableStringify(packageManifest(b, "out_lib")),
    );
  });

  it("同じプロジェクトの別のライブラリは、別の中身になる", () => {
    const s = asLibrary(gunAndTargetSample(), ["ks_gun"]);
    s.outputs.push({
      id: "out_lib2",
      name: "lib2",
      kind: "library",
      systems: [],
      keep: [],
      resources: ["sys_shoot"],
    });
    expect(packageManifest(s, "out_lib").exports.map((e) => e.id)).toEqual(["ks_gun"]);
    expect(packageManifest(s, "out_lib2").exports.map((e) => e.id)).toEqual(["sys_shoot"]);
    // ライブラリでないアウトプットは何も入らない
    expect(packageManifest(s, "out_range").exports).toEqual([]);
  });

  it("stableStringify はキーの順に左右されない", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
