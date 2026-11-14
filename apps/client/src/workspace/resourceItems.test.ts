import { emptyProject, ProjectDoc, packageManifest, packageResourceId } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { resourceItems } from "./resourceItems";

const dep = { alias: "parts", packageId: "w_parts", version: 2, contentHash: "hash2" };

function loaded() {
  const source = new ProjectDoc();
  source.load(emptyProject("部品"));
  const prefab = source.addPrefab("的");
  const library = source.addOutput("部品集", "library");
  source.setIncluded(library, prefab, true);
  const project = new ProjectDoc();
  project.load(emptyProject("作品"));
  project.addDependency(dep);
  project.setPackagePrefabs([
    { status: "ready", dependency: dep, manifest: packageManifest(source.snapshot(), library) },
  ]);
  return { project, prefab: packageResourceId(dep, prefab) };
}

describe("Resources のライブラリのプレハブ", () => {
  it("読み取り専用のフォルダに、選んだバージョンのプレハブを並べる", () => {
    const { project, prefab } = loaded();
    const items = resourceItems(project);
    const folder = items.find((item) => item.name === "@parts · v2");
    expect(folder).toMatchObject({ kind: "folder", readOnly: true });
    expect(items.find((item) => item.id === prefab)).toMatchObject({
      kind: "prefab",
      name: "的",
      parent: folder?.id,
      readOnly: true,
    });
    expect(project.prefabs()).toEqual([]);
  });

  it("依存を外すと、前に読み込んだプレハブを並べない", () => {
    const { project, prefab } = loaded();
    project.removeDependency(dep.alias);
    expect(resourceItems(project).some((item) => item.id === prefab)).toBe(false);
    expect(project.prefab(prefab)).toBeUndefined();
  });

  it("同じ依存を持つ保存へ戻しても、読み込んだ定義を使える", () => {
    const { project, prefab } = loaded();
    project.load(project.snapshot());
    expect(resourceItems(project).some((item) => item.id === prefab)).toBe(true);
    expect(project.prefab(prefab)?.name).toBe("的");
  });
});
