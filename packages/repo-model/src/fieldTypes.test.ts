import type { FieldSchemas, ValueSchema } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import { BUILTIN } from "./builtins";
import { ProjectDependencyGraph, usersOf } from "./dependencyGraph";
import { checkProjectReferences } from "./diagnostics/references";
import { extractInto } from "./extract";
import {
  BASIC_FIELD_TYPES,
  basicFieldType,
  checkFieldValues,
  emptyValueOf,
  parseFieldSchemas,
} from "./fieldTypes";
import { emptyProject } from "./samples";
import type { ProjectSnapshot } from "./schema";

/** `{ label: string; owner: EntityRef | undefined; skin: MaterialRef }[]`（TypeScript で作ったスキーマの代わり） */
const cards: ValueSchema = {
  kind: "list",
  item: {
    kind: "record",
    fields: [
      { name: "label", optional: false, schema: { kind: "string" } },
      {
        name: "owner",
        optional: false,
        schema: {
          kind: "union",
          options: [{ kind: "ref", target: "entity" }, { kind: "undefined" }],
        },
      },
      { name: "skin", optional: false, schema: { kind: "ref", target: "material" } },
    ],
  },
};
const schemas: FieldSchemas = { ks_hand: { f_cards: cards } };

function project(): ProjectSnapshot {
  const p = emptyProject("手札");
  const out = p.outputs[0]?.id ?? "out";
  p.kokostates = [
    {
      id: "ks_hand",
      name: "Hand",
      fields: [
        {
          id: "f_cards",
          name: "cards",
          type: "{ label: string; owner: EntityRef | undefined; skin: MaterialRef }[]",
          default: [],
        },
        { id: "f_n", name: "n", type: "number", default: 0 },
      ],
    },
  ];
  p.materials = [{ id: "mat_a", name: "赤", color: "#ff0000", roughness: 0.5, metalness: 0 }];
  p.entities = ["ent_a", "ent_b"].map((id, order) => ({
    id,
    name: id,
    parent: null,
    output: out,
    order,
    states: {
      ks_hand: {
        f_cards: [{ label: "A", owner: id === "ent_a" ? "ent_b" : undefined, skin: "mat_a" }],
        f_n: 1,
      },
    },
  }));
  return p;
}

describe("値が型に合っているかを確かめる（ADR 0065）", () => {
  it("合っていれば、問題は出ない", () => {
    expect(checkFieldValues(project(), schemas)).toEqual([]);
  });

  it("Entity の値と、初期値のずれを、その場所の問題にする", () => {
    const p = project();
    const a = p.entities[0];
    if (a?.states.ks_hand) {
      a.states.ks_hand.f_cards = [{ label: 1, owner: undefined, skin: "mat_a" }];
      a.states.ks_hand.f_n = "many";
    }
    const def = p.kokostates[0]?.fields[1];
    if (def) def.default = "zero";
    const found = checkFieldValues(p, schemas).map((d) => [
      d.code,
      d.subject,
      d.location,
      d.detail,
    ]);
    expect(found).toEqual([
      [
        "default-type-mismatch",
        { kind: "kokostate", id: "ks_hand" },
        { kind: "property", path: ["f_n", "default"] },
        "数ではありません",
      ],
      [
        "value-type-mismatch",
        { kind: "entity", id: "ent_a" },
        { kind: "property", path: ["ks_hand", "f_cards"] },
        "[0].label：文字ではありません",
      ],
      [
        "value-type-mismatch",
        { kind: "entity", id: "ent_a" },
        { kind: "property", path: ["ks_hand", "f_n"] },
        "数ではありません",
      ],
    ]);
  });

  it("スキーマが分からないフィールド（型エラーなど）は確かめない。Built-in の数は有限に限る", () => {
    const p = project();
    const a = p.entities[0];
    if (a) {
      a.states.ks_hand = { f_cards: "こわれた値", f_n: Number.NaN };
      a.states[BUILTIN.Transform] = { position: [0, Number.NaN, 0] };
    }
    // スキーマを渡さないと、cards は確かめない。n（number）は NaN でもよい
    expect(checkFieldValues(p).map((d) => d.location)).toEqual([
      { kind: "property", path: [BUILTIN.Transform, "position"] },
    ]);
  });
});

describe("入れ子の中の参照を、スキーマでたどる", () => {
  it("依存グラフ：入れ子の中の Entity とマテリアルにも辺を張る", () => {
    const graph = ProjectDependencyGraph.fromSnapshot(project(), schemas);
    expect(
      usersOf(graph, { kind: "material", id: "mat_a" })
        .map((r) => r.id)
        .sort(),
    ).toEqual(["ent_a", "ent_b"]);
    expect(graph.dependenciesOf({ kind: "entity", id: "ent_a" })).toContainEqual({
      kind: "entity",
      id: "ent_b",
    });
    // スキーマがなければ、込み入った型のフィールドはたどれない
    const blind = ProjectDependencyGraph.fromSnapshot(project());
    expect(usersOf(blind, { kind: "material", id: "mat_a" })).toEqual([]);
  });

  it("参照の診断：入れ子の中の参照切れを、そのフィールドの問題にする", () => {
    const p = project();
    p.materials = [];
    p.entities = p.entities.filter((e) => e.id === "ent_a");
    const found = checkProjectReferences(p, schemas).map((d) => [d.code, d.location]);
    expect(found).toEqual([
      ["missing-entity", { kind: "property", path: ["ks_hand", "f_cards"] }],
      ["missing-resource", { kind: "property", path: ["ks_hand", "f_cards"] }],
    ]);
  });

  it("抽出：振り直した ID を、入れ子の中の参照にも付け替える", () => {
    const src = project();
    const out = src.outputs[0]?.id ?? "";
    // 取り込み先に、同じ ID の別のマテリアルと Entity がある
    const dst = emptyProject("先");
    dst.materials = [{ id: "mat_a", name: "青", color: "#0000ff", roughness: 0.5, metalness: 0 }];
    dst.entities = [
      {
        id: "ent_b",
        name: "別の物",
        parent: null,
        output: dst.outputs[0]?.id ?? "",
        order: 0,
        states: {},
      },
    ];
    const merged = extractInto(
      src,
      { outputs: [out], kokostates: [], systems: [], materials: [], assets: [] },
      { repoId: "r", repoName: "元", commit: "c" },
      dst,
      undefined,
      schemas,
    );
    const mat = merged.materials.find((m) => m.name === "赤");
    const b = merged.entities.find((e) => e.name === "ent_b");
    const a = merged.entities.find((e) => e.name === "ent_a");
    expect(mat?.id).not.toBe("mat_a");
    expect(b?.id).not.toBe("ent_b");
    expect(a?.states.ks_hand?.f_cards).toEqual([{ label: "A", owner: b?.id, skin: mat?.id }]);
  });
});

describe("一覧から選べる型", () => {
  it("型の文から、一覧の型を見分ける", () => {
    expect(basicFieldType("EntityRef|undefined")?.key).toBe("entity");
    expect(basicFieldType("Vec3")?.label).toBe("Vector3");
    expect(basicFieldType("number[]")).toBeUndefined();
    for (const t of BASIC_FIELD_TYPES) expect(basicFieldType(t.type)).toBe(t);
  });

  it("型ごとの空の値", () => {
    expect(emptyValueOf(cards)).toEqual([]);
    expect(
      emptyValueOf({ kind: "union", options: [{ kind: "number" }, { kind: "undefined" }] }),
    ).toBeUndefined();
    expect(emptyValueOf((cards as { item: ValueSchema }).item)).toEqual({
      label: "",
      owner: undefined,
      skin: "",
    });
    expect(
      emptyValueOf({ kind: "Map", key: { kind: "string" }, value: { kind: "number" } }),
    ).toEqual(new Map());
  });
});

describe("外から届いたスキーマを受け取る", () => {
  it("形の合うものだけを残す", () => {
    expect(parseFieldSchemas(schemas)).toEqual(schemas);
    expect(
      parseFieldSchemas({
        ks: {
          ok: { kind: "list", item: { kind: "number" } },
          unknownKind: { kind: "function" },
          badRef: { kind: "ref", target: "password" },
          badItem: { kind: "list", item: { kind: "nope" } },
          notObject: "number",
        },
        notFields: 1,
      }),
    ).toEqual({ ks: { ok: { kind: "list", item: { kind: "number" } } } });
    expect(parseFieldSchemas(null)).toEqual({});
    expect(parseFieldSchemas([{ kind: "number" }])).toEqual({});
  });

  it("深すぎる入れ子は捨てる", () => {
    let deep: unknown = { kind: "number" };
    for (let i = 0; i < 100; i++) deep = { kind: "list", item: deep };
    expect(parseFieldSchemas({ ks: { f: deep } })).toEqual({ ks: {} });
  });
});
