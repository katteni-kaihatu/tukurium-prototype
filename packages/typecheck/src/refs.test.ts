import { emptyProject, type ProjectSnapshot } from "@tukurium/repo-model";
import { hostApiDeclarations } from "@tukurium/runtime";
import { describe, expect, it } from "vitest";
import { TypeChecker } from "./checker";
import { nodeTypeCheckerOptions } from "./node";

const checker = new TypeChecker(nodeTypeCheckerOptions());
const host = hostApiDeclarations();
const run = (snapshot: ProjectSnapshot) =>
  checker.checkAll({ snapshot, packages: new Map(), hostDeclarations: host });

/** Health（hp・label）と、それを指すゲージ */
function project(gaugeTypes: string[], code?: string): ProjectSnapshot {
  const p = emptyProject("参照");
  p.kokostates = [
    {
      id: "ks_health",
      name: "Health",
      fields: [
        { id: "f_hp", name: "hp", type: "number", default: 3 },
        { id: "f_label", name: "label", type: "string", default: "" },
      ],
    },
    {
      id: "ks_gauge",
      name: "Gauge",
      fields: gaugeTypes.map((type, i) => ({
        id: `f${i}`,
        name: `v${i}`,
        type,
        default: undefined,
      })),
    },
  ];
  if (code) p.systems = [{ id: "sys_a", name: "A", code }];
  return p;
}

const schemasOf = (types: string[]) => {
  const { schemas, diagnostics } = run(project(types));
  expect(diagnostics.map((d) => d.message)).toEqual([]);
  return types.map((_t, i) => schemas.ks_gauge?.[`f${i}`]);
};

describe("KokoState の参照とフィールドの参照の型（ADR 0065）", () => {
  it("型の文で、指せる KokoState と、指せるフィールドの型を決める", () => {
    expect(
      schemasOf([
        "KokoStateRef<Health>",
        "KokoStateRef<Health> | undefined",
        "KokoStateRef",
        "KokoStateRef<Transform>",
        "FieldRef<number>",
        "FieldRef",
        "Map<EntityRef, FieldRef<string | undefined>>",
        "KokoStateRef<Gauge>[]",
      ]),
    ).toEqual([
      { kind: "kokoRef", koko: "ks_health" },
      { kind: "union", options: [{ kind: "kokoRef", koko: "ks_health" }, { kind: "undefined" }] },
      { kind: "kokoRef" },
      { kind: "kokoRef", koko: "builtin.Transform" },
      { kind: "fieldRef", value: { kind: "number" } },
      { kind: "fieldRef" },
      {
        kind: "Map",
        key: { kind: "ref", target: "entity" },
        value: {
          kind: "fieldRef",
          value: { kind: "union", options: [{ kind: "string" }, { kind: "undefined" }] },
        },
      },
      { kind: "list", item: { kind: "kokoRef", koko: "ks_gauge" } },
    ]);
  });

  it("ない KokoState の名前は、そのフィールドの型エラーになる", () => {
    const { diagnostics } = run(project(["KokoStateRef<Stamina>", "number"]));
    expect(diagnostics.map((d) => [d.subject.id, d.location])).toEqual([
      ["ks_gauge", { kind: "property", path: ["f0", "type"] }],
    ]);
  });

  it("同じ名前の KokoState が二つあると、名前では指せない", () => {
    const p = project(["KokoStateRef<Health>"]);
    p.kokostates.push({ id: "ks_health2", name: "Health", fields: [] });
    p.folders = [{ id: "fld", name: "Other", parent: null }];
    p.placement = { ks_health2: "fld" };
    expect(run(p).diagnostics.some((d) => /Health/.test(d.message))).toBe(true);
  });

  it("System から、参照の先を型のとおりに読み書きできる", () => {
    const code = [
      'import Gauge from "./Gauge.koko";',
      'import Health from "./Health.koko";',
      "export default system({",
      "  query: { with: [Gauge] },",
      "  onUpdate(e) {",
      "    const g = e.get(Gauge);",
      "    const hp: number = world.getField(g.v1) ?? 0;",
      "    const state = g.v0 ? world.getState(g.v0) : undefined;",
      "    if (state) world.setState(g.v0!, { hp: state.hp + hp });",
      "    g.v0 = { entity: e.id, koko: Health.id };",
      "    world.setField(g.v1, 5);",
      "    g.v0 = { entity: e.id, koko: Gauge.id };",
      '    world.setField(g.v1, "many");',
      "    world.setState(g.v0!, { hpp: 1 });",
      "    const wrong: string = world.getField(g.v1) ?? '';",
      "    return wrong;",
      "  },",
      "});",
    ].join("\n");
    const { diagnostics } = run(
      project(["KokoStateRef<Health> | undefined", "FieldRef<number>"], code),
    );
    expect(
      diagnostics.map((d) => (d.location?.kind === "script" ? d.location.line : d.message)),
    ).toEqual([12, 13, 14, 15]);
  });
});
