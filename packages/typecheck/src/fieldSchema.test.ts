import { FIELD_TYPE, knownSchema, type ValueSchema } from "@tukurium/eks";
import {
  BUILTIN_KOKOSTATES,
  emptyProject,
  gunAndTargetSample,
  marubatsuSample,
  type ProjectSnapshot,
} from "@tukurium/repo-model";
import { hostApiDeclarations } from "@tukurium/runtime";
import { describe, expect, it } from "vitest";
import { TypeChecker } from "./checker";
import { fieldTypeSyntaxError } from "./fieldSchema";
import { nodeTypeCheckerOptions } from "./node";

const checker = new TypeChecker(nodeTypeCheckerOptions());
const host = hostApiDeclarations();
const run = (snapshot: ProjectSnapshot) =>
  checker.checkAll({ snapshot, packages: new Map(), hostDeclarations: host });

/** 型の文を並べた KokoState「K」を持つ制作データ（フィールドの ID は f0, f1, …） */
function project(types: string[], code?: string): ProjectSnapshot {
  const p = emptyProject("型");
  p.kokostates = [
    {
      id: "ks_k",
      name: "K",
      fields: types.map((type, i) => ({ id: `f${i}`, name: `v${i}`, type, default: undefined })),
    },
  ];
  if (code) p.systems = [{ id: "sys_a", name: "A", code }];
  return p;
}

const schemaOf = (type: string): ValueSchema | undefined => run(project([type])).schemas.ks_k?.f0;
const errorOf = (type: string): string | undefined =>
  run(project([type])).diagnostics.find((d) => d.subject.id === "ks_k")?.message;

const num: ValueSchema = { kind: "number" };
const str: ValueSchema = { kind: "string" };
const undef: ValueSchema = { kind: "undefined" };

describe("フィールドの型の文からスキーマを作る（ADR 0065）", () => {
  it("Tukurium が用意する型は、TypeScript を使わない読み方（knownSchema）と同じ結果になる", () => {
    const names = [
      "number",
      "string",
      "boolean",
      "bigint",
      "Date",
      "Vec3",
      "Color",
      "EntityRef",
      "TextureRef",
      "MaterialRef",
      "ModelRef",
      "AudioRef",
    ];
    const types = [...names, ...names.map((n) => `${n} | undefined`), ...Object.values(FIELD_TYPE)];
    const { schemas, diagnostics } = run(project(types));
    expect(diagnostics).toEqual([]);
    types.forEach((type, i) => {
      expect(knownSchema(type), type).toBeDefined();
      expect(schemas.ks_k?.[`f${i}`], type).toEqual(knownSchema(type));
    });
    expect(knownSchema("number[]")).toBeUndefined();
    expect(knownSchema("Card")).toBeUndefined();
    expect(knownSchema("toString")).toBeUndefined();
  });

  it("Built-in と同梱サンプルのフィールドは、すべてスキーマになる", () => {
    for (const snap of [gunAndTargetSample(), marubatsuSample()]) {
      const { schemas, diagnostics } = run(snap);
      expect(diagnostics.map((d) => d.message)).toEqual([]);
      for (const k of [...BUILTIN_KOKOSTATES, ...snap.kokostates])
        for (const f of k.fields)
          expect(schemas[k.id]?.[f.id], `${k.name}.${f.name}`).toBeDefined();
    }
  });

  it("レコード・リスト・選択肢・省略できるフィールド", () => {
    expect(schemaOf('{ suit: "spade" | "heart"; rank: number; joker?: boolean }[]')).toEqual({
      kind: "list",
      item: {
        kind: "record",
        fields: [
          {
            name: "suit",
            optional: false,
            schema: {
              kind: "union",
              options: [
                { kind: "literal", value: "spade" },
                { kind: "literal", value: "heart" },
              ],
            },
          },
          { name: "rank", optional: false, schema: num },
          {
            name: "joker",
            optional: true,
            schema: { kind: "union", options: [{ kind: "boolean" }, undef] },
          },
        ],
      },
    });
  });

  it("マップ（Record）・Map・Set・Date・bigint・タプル", () => {
    expect(schemaOf("Record<string, number[]>")).toEqual({
      kind: "map",
      value: { kind: "list", item: num },
    });
    // キーが決まっている Record は、レコードになる
    expect(schemaOf('Record<"white" | "black", number>')).toEqual({
      kind: "record",
      fields: [
        { name: "white", optional: false, schema: num },
        { name: "black", optional: false, schema: num },
      ],
    });
    expect(schemaOf("Map<EntityRef, bigint>")).toEqual({
      kind: "Map",
      key: { kind: "ref", target: "entity" },
      value: { kind: "bigint" },
    });
    expect(schemaOf("Set<string>")).toEqual({ kind: "Set", item: str });
    expect(schemaOf("[string, number, Date]")).toEqual({
      kind: "tuple",
      items: [str, num, { kind: "Date" }],
    });
    expect(schemaOf("Partial<{ a: number }>")).toEqual({
      kind: "record",
      fields: [{ name: "a", optional: true, schema: { kind: "union", options: [num, undef] } }],
    });
    expect(schemaOf("ReadonlyArray<string>")).toEqual({ kind: "list", item: str });
    expect(schemaOf("string | undefined | number")).toEqual({
      kind: "union",
      options: [str, num, undef],
    });
  });

  it("保存できない型は、理由を付けて、そのフィールドの型エラーにする", () => {
    expect(errorOf("() => void")).toMatch(/関数は保存できません/);
    expect(errorOf("{ run(): void; n: number }")).toMatch(/run：関数は保存できません/);
    expect(errorOf("Promise<number>")).toMatch(/Promise は保存できません/);
    expect(errorOf("RegExp")).toMatch(/RegExp は保存できません/);
    expect(errorOf("string | null")).toMatch(/null は使えません/);
    expect(errorOf("any")).toMatch(/any は使えません/);
    expect(errorOf("unknown[]")).toMatch(/unknown は使えません/);
    expect(errorOf("[string, number?]")).toMatch(/タプル/);
    expect(errorOf("Record<number, string>")).toMatch(/マップのキーは文字/);
    expect(errorOf("symbol")).toMatch(/symbol は保存できません/);
  });

  it("文として読めない型・知らない名前・続きに別の文を書いた型も、型エラーにする", () => {
    expect(errorOf("number[")).toBeDefined();
    expect(errorOf("")).toMatch(/型を書いてください/);
    expect(errorOf("Card[]")).toMatch(/Card/);
    expect(fieldTypeSyntaxError("number); declare const x: (1")).not.toBeNull();
    expect(fieldTypeSyntaxError("number")).toBeNull();
    expect(fieldTypeSyntaxError("{ a: number }[] // 手札")).toBeNull();
  });

  it("型エラーはそのフィールドに出し、ほかのフィールドは使える", () => {
    const code = [
      'import K from "./K.koko";',
      "export default system({",
      "  query: { with: [K] },",
      "  onUpdate(e) {",
      "    const k = e.get(K);",
      "    k.v0.push({ suit: 1 });",
      "    k.v0.push({ suit: 'spade' });",
      "    const broken: unknown = k.v1;",
      "    k.v2 = 'x';",
      "    return broken;",
      "  },",
      "});",
    ].join("\n");
    const { diagnostics, schemas } = run(
      project(["{ suit: string }[]", "() => void", "number"], code),
    );
    const fieldErrors = diagnostics.filter((d) => d.subject.kind === "kokostate");
    expect(fieldErrors).toHaveLength(1);
    expect(fieldErrors[0]).toMatchObject({
      code: "field-type-unsaveable",
      subject: { kind: "kokostate", id: "ks_k" },
      location: { kind: "property", path: ["f1", "type"] },
    });
    expect(Object.keys(schemas.ks_k ?? {}).sort()).toEqual(["f0", "f2"]);
    // スクリプトでは、レコードのフィールドの型の違いと、数のフィールドへの文字が型エラーになる
    const scriptLines = diagnostics
      .filter((d) => d.subject.kind === "system")
      .map((d) => (d.location?.kind === "script" ? d.location.line : null));
    expect(scriptLines).toEqual([6, 9]);
  });
});
