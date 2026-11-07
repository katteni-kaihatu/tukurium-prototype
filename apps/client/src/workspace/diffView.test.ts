import type { ProjectSnapshot } from "@tukurium/repo-model";
import { BUILTIN, gunAndTargetSample } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { describeDiff, lineChanges, lineDiff } from "./diffView";

function snap(partial: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    version: 1,
    name: "作品",
    kokostates: [],
    systems: [],
    materials: [],
    assets: [],
    outputs: [{ id: "out", name: "射撃場", kind: "item", systems: [], keep: [] }],
    entities: [],
    ...partial,
  };
}

describe("describeDiff", () => {
  it("エンティティはファイル名ではなく名前で出し、階層と KokoState の前後を付ける", () => {
    const before = snap({
      kokostates: [
        {
          id: "ks",
          name: "Gun",
          fields: [{ id: "f", name: "ammo", type: "number", default: 0 }],
        },
      ],
      entities: [
        {
          id: "p",
          name: "親",
          parent: null,
          output: "out",
          order: 0,
          states: {},
        },
        {
          id: "c",
          name: "子",
          parent: "p",
          output: "out",
          order: 0,
          states: { ks: { f: 12 } },
        },
      ],
    });
    const after = structuredClone(before);
    const child = after.entities.find((e) => e.id === "c");
    if (!child) throw new Error("子がない");
    child.name = "鉄砲";
    child.parent = null;
    child.states.ks = { f: 7 };
    const hit = describeDiff(before, after).find((e) => e.group === "entity");
    expect(hit?.name).toBe("鉄砲");
    expect(hit?.id).not.toContain(".json");
    expect(hit?.lines).toEqual(
      expect.arrayContaining([
        { label: "名前", before: "子", after: "鉄砲", part: "name" },
        { label: "階層", before: "射撃場 / 親 / 子", after: "射撃場 / 鉄砲", part: "place" },
        expect.objectContaining({
          label: "ammo",
          before: "12",
          after: "7",
          section: { key: "state:ks", label: "Gun", change: "modified" },
        }),
      ]),
    );
    expect(describeDiff(before, after).some((e) => e.name === "親")).toBe(false);
  });

  it("Entity の KokoState は、KokoState ごとの見出しにまとめる", () => {
    const before = snap({
      entities: [
        {
          id: "e",
          name: "箱",
          parent: null,
          output: "out",
          order: 0,
          states: { ks: { f: 1 }, [BUILTIN.Collider]: {} },
        },
      ],
    });
    const after = structuredClone(before);
    const e = after.entities[0];
    if (!e) throw new Error("ない");
    e.states = { [BUILTIN.Transform]: { position: [0, 1, 0] }, ks: { f: 1 } };
    const lines = describeDiff(before, after).find((x) => x.group === "entity")?.lines ?? [];
    const heads = [
      ...new Map(lines.flatMap((l) => (l.section ? [[l.section.key, l.section]] : []))).values(),
    ];
    expect(heads).toEqual([
      { key: `state:${BUILTIN.Collider}`, label: "Collider", change: "removed" },
      { key: `state:${BUILTIN.Transform}`, label: "Transform", change: "added" },
    ]);
    // 欄の名前は見出しを付けずに出す
    expect(lines.find((l) => l.section?.label === "Transform")?.label).toBe("position");
  });

  it("アウトプットの名前だけ変えても、中のエンティティは出さない", () => {
    const before = snap({
      entities: [{ id: "e", name: "箱", parent: null, output: "out", order: 0, states: {} }],
    });
    const after = structuredClone(before);
    const output = after.outputs[0];
    if (!output) throw new Error("アウトプットがない");
    output.name = "的当て";
    expect(describeDiff(before, after).map((e) => e.name)).toEqual(["的当て"]);
  });

  it("アウトプットは名前で出し、システムと状態維持の前後を付ける", () => {
    const before = gunAndTargetSample();
    const after = structuredClone(before);
    const output = after.outputs[0];
    if (!output) throw new Error("アウトプットがない");
    output.name = "的当て";
    output.systems = [{ id: "sys_target", enabled: false }];
    output.keep = [];
    const hit = describeDiff(before, after).find((e) => e.group === "output");
    expect(hit?.name).toBe("的当て");
    expect(hit?.lines).toEqual(
      expect.arrayContaining([
        { label: "名前", before: "射撃場", after: "的当て", part: "name" },
        {
          label: "システム",
          before: "Shoot、TargetHit",
          after: "TargetHit（停止）",
          part: "systems",
        },
        {
          label: "状態維持",
          before: "銃 の Gun / ammo",
          after: "（なし）",
          part: "keep",
        },
      ]),
    );
  });

  it("コードは変わった行だけを残す", () => {
    const before = snap({
      systems: [{ id: "s", name: "Shoot", code: "let a = 1;\nlet b = 2;\nlet c = 3;\n" }],
    });
    const after = structuredClone(before);
    const system = after.systems[0];
    if (!system) throw new Error("コードがない");
    system.code = "let a = 1;\nlet b = 9;\nlet c = 3;\n";
    const hit = describeDiff(before, after).find((e) => e.group === "code");
    expect(hit?.name).toBe("Shoot");
    expect(hit?.code).toEqual([
      { kind: "same", text: "let a = 1;" },
      { kind: "del", text: "let b = 2;" },
      { kind: "add", text: "let b = 9;" },
      { kind: "same", text: "let c = 3;" },
    ]);
  });

  it("同じ名前のテクスチャの入れ替えは、左右の素材 ID を一つにまとめる", () => {
    const before = snap({
      assets: [{ id: "old", name: "木目", kind: "image", contentType: "image/png" }],
    });
    const after = snap({
      assets: [{ id: "new", name: "木目", kind: "image", contentType: "image/png" }],
    });
    const images = describeDiff(before, after).filter((e) => e.group === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      name: "木目",
      kind: "modified",
      preview: { kind: "image", beforeId: "old", afterId: "new" },
    });
  });

  it("新しいモデルは、変更前を空にして出す", () => {
    const before = snap();
    const after = snap({
      assets: [{ id: "glb", name: "銃", kind: "model", contentType: "model/gltf-binary" }],
    });
    const hit = describeDiff(before, after).find((e) => e.group === "model");
    expect(hit).toMatchObject({
      name: "銃",
      kind: "added",
      preview: { kind: "model", beforeId: null, afterId: "glb" },
    });
  });
});

describe("lineDiff", () => {
  it("離れた同じ行は省略する", () => {
    const before = ["a", "b", "c", "d", "e", "f"].join("\n");
    const after = ["a", "B", "c", "d", "e", "F"].join("\n");
    expect(lineDiff(before, after, 0).map((r) => r.kind)).toEqual([
      "del",
      "add",
      "gap",
      "del",
      "add",
    ]);
  });
});

describe("lineChanges", () => {
  const sets = (c: ReturnType<typeof lineChanges>) => ({
    added: [...c.added],
    modified: [...c.modified],
    deletedAfter: [...c.deletedAfter],
  });

  it("足した行・書き換えた行・消したところを、今の行番号で出す", () => {
    const before = "a\nb\nc\nd\ne\n";
    const after = "a\nB\nc\nnew\ne\n";
    // b → B は書き換え、d → new も書き換え
    expect(sets(lineChanges(before, after))).toEqual({
      added: [],
      modified: [2, 4],
      deletedAfter: [],
    });
  });

  it("足しただけの行は足した、消しただけのところは消した印にする", () => {
    expect(sets(lineChanges("a\nb\n", "a\nx\ny\nb\n"))).toEqual({
      added: [2, 3],
      modified: [],
      deletedAfter: [],
    });
    expect(sets(lineChanges("a\nb\nc\n", "a\nc\n"))).toEqual({
      added: [],
      modified: [],
      deletedAfter: [1],
    });
    expect(sets(lineChanges("a\nb\n", "b\n"))).toEqual({
      added: [],
      modified: [],
      deletedAfter: [0],
    });
  });

  it("書き換えより足した行が多ければ、余りを足した行にする", () => {
    expect(sets(lineChanges("a\nb\nc\n", "a\nB1\nB2\nc\n"))).toEqual({
      added: [3],
      modified: [2],
      deletedAfter: [],
    });
  });

  it("同じなら何も出さない", () => {
    expect(sets(lineChanges("a\nb\n", "a\nb\n"))).toEqual({
      added: [],
      modified: [],
      deletedAfter: [],
    });
  });
});
