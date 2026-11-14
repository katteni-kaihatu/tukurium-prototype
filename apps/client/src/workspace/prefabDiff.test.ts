import { BUILTIN, emptyProject, fromFiles, ProjectDoc, toFiles } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { describeDiff } from "./diffView";
import { planRevert } from "./revert";

const OUT = "out_main";

/** 的のプレハブ（芯つき）と、そのインスタンスを一つ置いて保存したところ */
function setup() {
  const project = new ProjectDoc();
  project.load(emptyProject("プレハブ"));
  const prefab = project.addPrefab("的");
  const root = project.prefab(prefab)?.root ?? "";
  const core = project.addPrefabEntity({
    prefab,
    name: "芯",
    states: { [BUILTIN.Transform]: { position: [0, 1, 0] } },
  });
  const instance = project.addInstance({ output: OUT, prefab });
  // 保存したもの（ファイルを通した形）と比べる
  const head = fromFiles(toFiles(project.snapshot()));
  const diff = () => describeDiff(head, project.snapshot());
  const revert = (id: string) => {
    const plan = planRevert(project, head, id);
    if (!plan) throw new Error(`戻せない: ${id}`);
    plan();
  };
  return { project, head, prefab, root, core, instance, diff, revert };
}

describe("プレハブの差分と戻す（ADR 0076）", () => {
  it("保存したままなら、差分は出ない", () => {
    expect(setup().diff()).toEqual([]);
  });

  it("新しいプレハブとインスタンスは、名前で出る", () => {
    const { project, diff } = setup();
    const box = project.addPrefab("箱");
    project.addInstance({ output: OUT, prefab: box, name: "箱1" });
    const entries = diff();
    expect(entries.map((e) => [e.id, e.name, e.kind])).toEqual([
      [expect.stringMatching(/^entity:/), "箱1", "added"],
      [`prefab:${box}`, "箱", "added"],
    ]);
    expect(entries[0]?.lines).toContainEqual({ label: "プレハブ", before: null, after: "箱" });
  });

  it("プレハブの中を変えると、変えた所が出て、まとめて戻せる", () => {
    const { project, prefab, core, diff, revert } = setup();
    project.renamePrefab(prefab, "まと");
    project.setField(core, BUILTIN.Transform, "position", [0, 2, 0]);
    const added = project.addPrefabEntity({ prefab, name: "飾り" });
    const [entry] = diff();
    expect(entry).toMatchObject({ id: `prefab:${prefab}`, name: "まと", kind: "modified" });
    expect(entry?.lines).toEqual([
      { label: "名前", before: "的", after: "まと", part: "name" },
      { label: "中の「芯」", before: "変える前", after: "変えた所：Transform.position" },
      { label: "中の「飾り」", before: null, after: "足した" },
    ]);
    revert(`prefab:${prefab}`);
    expect(diff()).toEqual([]);
    expect(project.prefabEntity(added)).toBeUndefined();
    expect(project.prefab(prefab)?.name).toBe("的");
  });

  it("消したプレハブは戻せる。足したプレハブは、戻すと消える", () => {
    const { project, prefab, root, core, instance, diff, revert } = setup();
    project.removePrefab(prefab);
    expect(diff().map((e) => [e.id, e.kind])).toEqual([[`prefab:${prefab}`, "removed"]]);
    revert(`prefab:${prefab}`);
    expect(diff()).toEqual([]);
    expect(
      project
        .prefabEntities(prefab)
        .map((e) => e.id)
        .sort(),
    ).toEqual([root, core].sort());
    expect(project.entity(instance)?.instanceOf).toEqual({ prefab });

    const box = project.addPrefab("箱");
    revert(`prefab:${box}`);
    expect(project.prefab(box)).toBeUndefined();
    expect(project.prefabEntities(box)).toEqual([]);
    expect(diff()).toEqual([]);
  });
});
