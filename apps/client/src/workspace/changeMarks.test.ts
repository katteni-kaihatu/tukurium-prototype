import type { EntityDef, ProjectSnapshot } from "@tukurium/repo-model";
import { toFiles } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import {
  canParent,
  dropPlacement,
  entityChange,
  kokoChange,
  materialChange,
  outputChange,
  systemChange,
  treeMark,
} from "./changeMarks";

function snap(partial: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    version: 1,
    name: "試す",
    kokostates: [],
    systems: [],
    materials: [],
    outputs: [{ id: "out", name: "場", kind: "item", systems: [], keep: [] }],
    entities: [],
    ...partial,
  };
}

function box(patch: Partial<EntityDef> = {}): EntityDef {
  return {
    id: "ent",
    name: "箱",
    parent: null,
    output: "out",
    order: 0,
    states: { "builtin.Transform": { position: [0, 1, 0] } },
    ...patch,
  };
}

describe("保存との差", () => {
  it("保存がまだなければ印を出さない", () => {
    expect(entityChange(null, box()).kind).toBeNull();
  });

  it("ファイルにない Entity は新しく、中の KokoState も新しい", () => {
    const mark = entityChange(toFiles(snap()), box());
    expect(mark.kind).toBe("added");
    expect(mark.name).toBe("added");
    expect(mark.parent).toBeNull();
    expect(mark.states["builtin.Transform"]?.kind).toBe("added");
    expect(mark.states["builtin.Transform"]?.fields).toEqual({ position: "added" });
  });

  it("名前・親・フィールドの変化を分け、並び順だけでは印を出さない", () => {
    const before = box();
    const head = toFiles(snap({ entities: [before] }));
    expect(entityChange(head, { ...before, order: 4 }).kind).toBeNull();

    const renamed = entityChange(head, { ...before, name: "大きな箱" });
    expect(renamed).toMatchObject({ kind: "modified", name: "modified", parent: null });

    const moved = entityChange(head, { ...before, parent: "ent_root" });
    expect(moved.parent).toBe("modified");

    const valued = entityChange(head, {
      ...before,
      states: { "builtin.Transform": { position: [1, 1, 0] } },
    });
    expect(valued.states["builtin.Transform"]).toEqual({
      kind: "modified",
      fields: { position: "modified" },
    });
  });

  it("後から付けた KokoState は新しく、維持の切り替えはフィールドの変化", () => {
    const before = box();
    const head = toFiles(snap({ entities: [before] }));
    const added = entityChange(head, {
      ...before,
      states: { ...before.states, ks_hp: { f_hp: 3 } },
    });
    expect(added.states.ks_hp).toEqual({ kind: "added", fields: { f_hp: "added" } });

    const kept = entityChange(head, before, {
      saved: [],
      current: [{ entity: "ent", koko: "builtin.Transform", field: "position" }],
    });
    expect(kept.kind).toBe("modified");
    expect(kept.states["builtin.Transform"]?.fields.position).toBe("modified");
  });

  it("KokoState の定義は、新しいフィールドと変わった初期値を分ける", () => {
    const def = {
      id: "ks_hp",
      name: "体力",
      fields: [{ id: "f_hp", name: "hp", type: "number" as const, default: 10 }],
    };
    const head = toFiles(snap({ kokostates: [def] }));
    expect(
      kokoChange(head, {
        ...def,
        fields: [...def.fields, { id: "f_max", name: "max", type: "number", default: 10 }],
      }).fields,
    ).toEqual({ f_max: "added" });
    const hp = def.fields[0];
    if (!hp) throw new Error("field");
    expect(kokoChange(head, { ...def, fields: [{ ...hp, default: 5 }] }).fields.f_hp).toBe(
      "modified",
    );
    expect(kokoChange(head, { ...def, builtin: true }).kind).toBeNull();
  });

  it("System は名前とコードを分け、マテリアルとアウトプットも箇所を分ける", () => {
    const head = toFiles(
      snap({
        systems: [{ id: "sys", name: "動かす", code: "export default system({});\n" }],
        materials: [{ id: "mat", name: "木", color: "#fff", roughness: 1, metalness: 0 }],
        outputs: [
          {
            id: "out",
            name: "場",
            kind: "item",
            systems: [{ id: "sys", enabled: true }],
            keep: [],
          },
        ],
      }),
    );
    expect(systemChange(head, "sys", "動かす", "export default system({});\n").kind).toBeNull();
    expect(systemChange(head, "sys", "止める", "export default system({});\n").name).toBe(
      "modified",
    );
    expect(systemChange(head, "sys", "動かす", "export default system({ a: 1 });\n").code).toBe(
      "modified",
    );
    expect(systemChange(head, "sys_new", "新しい", "x").kind).toBe("added");

    expect(
      materialChange(head, { id: "mat", name: "木", color: "#000", roughness: 1, metalness: 0 })
        .color,
    ).toBe("modified");
    const out = outputChange(head, {
      id: "out",
      name: "場",
      kind: "item",
      systems: [
        { id: "sys", enabled: false },
        { id: "sys_b", enabled: true },
      ],
      keep: [],
    });
    expect(out.systemRows).toEqual({ sys: "modified", sys_b: "added" });
    expect(out.systems).toBe("modified");
  });
});

describe("階層", () => {
  const nodes = [
    { id: "a", parent: null },
    { id: "b", parent: "a" },
    { id: "c", parent: "b" },
  ];

  it("自分と、自分の中には落とせない", () => {
    expect(canParent(nodes, "b", "a")).toBe(true);
    expect(canParent(nodes, "b", null)).toBe(true);
    expect(canParent(nodes, "a", "a")).toBe(false);
    expect(canParent(nodes, "a", "c")).toBe(false);
    expect(canParent(nodes, "a", "missing")).toBe(false);
  });

  it("行の端は並び替え、真ん中は子にする", () => {
    const nodes = [
      { id: "a", parent: null },
      { id: "b", parent: null },
      { id: "c", parent: "a" },
    ];
    expect(dropPlacement(nodes, "b", "a", "before")).toEqual({ parent: null, index: 0 });
    expect(dropPlacement(nodes, "b", "a", "after")).toEqual({ parent: null, index: 1 });
    expect(dropPlacement(nodes, "b", "a", "inside")).toEqual({ parent: "a", index: 1 });
    expect(dropPlacement(nodes, "a", "c", "inside")).toBeNull();
    expect(dropPlacement(nodes, "a", null, "inside")).toEqual({ parent: null, index: 1 });
  });

  it("閉じているときだけ、中の変化を外側の丸にする", () => {
    expect(treeMark(null, false, ["added"])).toEqual({ kind: null, nested: false });
    expect(treeMark(null, true, ["modified"])).toEqual({ kind: "modified", nested: true });
    expect(treeMark(null, true, ["modified", "added"])).toEqual({ kind: "added", nested: true });
    expect(treeMark("modified", true, ["added"])).toEqual({ kind: "modified", nested: false });
  });
});
