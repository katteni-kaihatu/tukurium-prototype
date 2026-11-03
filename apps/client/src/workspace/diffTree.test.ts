import type { FileChange } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { buildDiffTree } from "./diffTree";

const file = (path: string, change: FileChange["change"] = "modified"): FileChange => ({
  path,
  change,
  add: 1,
  del: 0,
});

describe("buildDiffTree", () => {
  it("パスをフォルダに分け、フォルダを先に名前順で並べる", () => {
    const tree = buildDiffTree([
      file("tukurium.json"),
      file("systems/b.js"),
      file("kokostates/a.json", "added"),
      file("systems/a.js", "removed"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["kokostates", "systems", "tukurium.json"]);
    const systems = tree[1];
    expect(systems?.children.map((n) => n.name)).toEqual(["a.js", "b.js"]);
    expect(systems?.children[0]?.change?.change).toBe("removed");
    expect(tree[0]?.children[0]?.change?.change).toBe("added");
  });

  it("差分がなければ空", () => {
    expect(buildDiffTree([])).toEqual([]);
  });
});
