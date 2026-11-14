import type { EntityDef, PrefabDef, PrefabEntityDef, ProjectSnapshot } from "@tukurium/repo-model";
import { toFiles } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import {
  canParent,
  dropPlacement,
  entityChange,
  kokoChange,
  materialChange,
  outputChange,
  prefabChange,
  savedPrefabKeep,
  systemChange,
  treeMark,
  typeDefChange,
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

    // プレハブのインスタンスになった（Entity からプレハブを作った）ら、変わった印を出す
    const linked = entityChange(head, { ...before, instanceOf: { prefab: "pf_box" } });
    expect(linked).toMatchObject({ kind: "modified", name: null, parent: null, states: {} });

    const valued = entityChange(head, {
      ...before,
      states: { "builtin.Transform": { position: [1, 1, 0] } },
    });
    expect(valued.states["builtin.Transform"]).toEqual({
      kind: "modified",
      fields: { position: "modified" },
    });
  });

  it("広げた値と、参照の「なし」（undefined）を、保存と比べられる（ADR 0065）", () => {
    const values = (patch: Record<string, unknown> = {}) =>
      ({
        mat: undefined,
        at: new Date(5),
        board: new Map([["a1", { kind: "pawn" }]]),
        big: 3n,
        nan: Number.NaN,
        ...patch,
      }) as unknown as EntityDef["states"][string];
    const head = toFiles(snap({ entities: [box({ states: { ks: values() } })] }));
    // 保存したファイルはタグ付きの JSON。同じ値なら印を出さない
    expect(entityChange(head, box({ states: { ks: values() } })).kind).toBeNull();
    const changed = entityChange(
      head,
      box({
        states: { ks: values({ mat: "mat_a", board: new Map([["a1", { kind: "rook" }]]) }) },
      }),
    );
    expect(changed.states.ks).toEqual({
      kind: "modified",
      fields: { mat: "modified", board: "modified" },
    });

    // KokoState の初期値も同じ
    const field = { id: "mat", name: "mat", type: "MaterialRef | undefined" };
    const def = (value: string | undefined) => ({
      id: "ks",
      name: "K",
      fields: [{ ...field, default: value }],
    });
    const saved = toFiles(snap({ kokostates: [def(undefined)] }));
    expect(kokoChange(saved, def(undefined)).kind).toBeNull();
    expect(kokoChange(saved, def("mat_a")).fields).toEqual({ mat: "modified" });
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

  it("型の定義は名前とコードを分け、KokoState は使う型の定義の出し入れも変化にする（ADR 0065）", () => {
    const def = { id: "ks", name: "Hand", fields: [], typeDefs: ["td"] };
    const head = toFiles(
      snap({ kokostates: [def], types: [{ id: "td", name: "Cards", code: "export type A = 1;" }] }),
    );
    expect(typeDefChange(head, "td", "Cards", "export type A = 1;").kind).toBeNull();
    expect(typeDefChange(head, "td", "Deck", "export type A = 1;")).toEqual({
      kind: "modified",
      name: "modified",
      code: null,
    });
    expect(typeDefChange(head, "td", "Cards", "export type A = 2;").code).toBe("modified");
    expect(typeDefChange(head, "td_new", "New", "").kind).toBe("added");
    expect(kokoChange(head, def).kind).toBeNull();
    expect(kokoChange(head, { ...def, typeDefs: [] }).kind).toBe("modified");
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

describe("プレハブの中の変化（ADR 0076）", () => {
  const prefab: PrefabDef = { id: "pf", name: "的", root: "ent_root", systems: [], keep: [] };
  const root: PrefabEntityDef = {
    id: "ent_root",
    name: "的",
    parent: null,
    prefab: "pf",
    order: 0,
    states: { "builtin.Transform": { position: [0, 0, 0] } },
  };
  const core: PrefabEntityDef = {
    id: "ent_core",
    name: "芯",
    parent: "ent_root",
    prefab: "pf",
    order: 0,
    states: { "builtin.Transform": { position: [0, 1, 0] } },
  };
  const head = toFiles(snap({ prefabs: [prefab], prefabEntities: [root, core] }));

  it("中の Entity を、プレハブのファイルと比べる", () => {
    expect(entityChange(head, core).kind).toBeNull();
    const moved = entityChange(head, {
      ...core,
      states: { "builtin.Transform": { position: [0, 2, 0] } },
    });
    expect(moved.states["builtin.Transform"]?.fields).toEqual({ position: "modified" });
    expect(entityChange(head, { ...core, id: "ent_new" }).kind).toBe("added");
    // 「維持」の切り替えは、そのフィールドの変化にする（印は、プレハブが持つ）
    const kept = entityChange(head, core, {
      saved: savedPrefabKeep(head, "pf"),
      current: [{ entity: "ent_core", koko: "builtin.Transform", field: "position" }],
    });
    expect(kept.states["builtin.Transform"]?.fields).toEqual({ position: "modified" });
  });

  it("プレハブは、設定か、中の Entity のどれかが変わっていれば「変わった」", () => {
    expect(prefabChange(null, prefab, [root, core])).toBeNull();
    expect(prefabChange(head, prefab, [root, core])).toBeNull();
    expect(prefabChange(toFiles(snap()), prefab, [root, core])).toBe("added");
    expect(prefabChange(head, { ...prefab, editIn: "isolated" }, [root, core])).toBe("modified");
    expect(prefabChange(head, prefab, [root, { ...core, name: "まんなか" }])).toBe("modified");
    // 中の Entity が増えた・減った
    expect(prefabChange(head, prefab, [root])).toBe("modified");
    expect(prefabChange(head, prefab, [root, core, { ...core, id: "ent_new" }])).toBe("modified");
    // 並び順だけの違いは、印にしない
    expect(prefabChange(head, prefab, [root, { ...core, order: 3 }])).toBeNull();
  });
});
