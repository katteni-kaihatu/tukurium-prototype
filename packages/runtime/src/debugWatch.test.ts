import type { Value } from "@tukurium/eks";
import { BUILTIN, type DebugSettings, emptyProject } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import type { DebugStop } from "./debugRuntime";
import { Simulation } from "./simulation";

async function run(body: string, condition = "", type = "number", initial: Value = 0) {
  const stops: DebugStop[] = [];
  const config: DebugSettings = {
    enabled: true,
    breakOnError: false,
    breakpoints: [],
    watches: [{ id: "w", enabled: true, entity: "e", koko: "c", field: "amount", condition }],
  };
  const project = {
    ...emptyProject("watch"),
    kokostates: [
      {
        id: "c",
        name: "C",
        fields: [{ id: "amount", name: "n", type, default: initial }],
      },
    ],
    systems: [
      {
        id: "s",
        name: "S",
        code: `import C from './C.koko';\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\n${body}\n}});`,
      },
    ],
    outputs: [
      {
        id: "out",
        name: "Out",
        kind: "item" as const,
        systems: [{ id: "s", enabled: true }],
        keep: [],
      },
    ],
    entities: [
      {
        id: "e",
        name: "E",
        output: "out",
        parent: null,
        order: 0,
        states: { c: { amount: initial } },
      },
    ],
  };
  const sim = await Simulation.create(project, "out", {
    realm: "r",
    debug: {
      settings: () => config,
      onPause: (s) => {
        stops.push(s);
        sim.debug?.resume(s.id);
      },
    },
  });
  try {
    await sim.stepDebug(0.1);
    return { stops, value: sim.world.get("e", "c")?.amount, error: sim.systemStatus()[0]?.error };
  } finally {
    sim.dispose();
  }
}
describe("フィールドの変化", () => {
  it("型に合わず取り込まれない書き換えでは止まらない", async () => {
    const result = await run("c.n=String(2);");
    expect(result.stops).toEqual([]);
    expect(result.value).toBe(0);
  });
  it("手元の値とworld.setの変更を分け、停止用の表示で上書きしない", async () => {
    const result = await run("c.n=1;world.set(e.id,C,{n:2});log(world.get(e.id,C).n);");
    expect(result.stops.map((s) => s.change?.newValue)).toEqual([1, 2]);
    expect(result.stops[1]?.states.find((s) => s.id === "c")?.fields[0]?.value).toBe(2);
    expect(result.value).toBe(1);
  });
  it("optional callの引数内の書き換えも捉える", async () => {
    const result = await run(
      "const o={m(){}};o?.m(world.set(e.id,C,{n:1}),world.set(e.id,C,{n:0}));",
    );
    expect(result.stops.map((s) => s.change?.newValue)).toEqual([1, 0]);
  });
  it("for-ofの暗黙の代入も捉える", async () => {
    const result = await run("for(c.n[0] of [1,2]) {}", "", "number[]", [0]);
    expect(result.stops.map((s) => s.change?.newValue)).toEqual([[1], [2]]);
  });
  it("delete によるフィールド内の削除を検出する", async () => {
    const result = await run("delete c.n.x;", "", "{ x?: number }", { x: 1 });
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]?.change?.newValue).toEqual({});
  });
  it("forの更新式は本体の行ではなく更新式の行を示す", async () => {
    const result = await run("for(c.n=0;c.n<2;c.n++){\nconst a=1;\n}");
    expect(result.stops.map((s) => s.line)).toEqual([4, 4]);
  });
  it("配列の中を書き換えた場合も直後に止まる", async () => {
    const result = await run("c.n[0]=3; c.n.push(4);", "", "number[]", [0]);
    expect(result.stops.map((s) => s.change?.newValue)).toEqual([[3], [3, 4]]);
  });
  it("物理演算の変更元と前後の値を出す", async () => {
    const p = {
      ...emptyProject("physics"),
      outputs: [{ id: "out", name: "Out", kind: "item" as const, systems: [], keep: [] }],
      entities: [
        {
          id: "e",
          name: "E",
          output: "out",
          parent: null,
          order: 0,
          states: {
            [BUILTIN.Transform]: { position: [0, 3, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            [BUILTIN.Mesh]: { shape: "sphere", size: [0.5, 0.5, 0.5], color: "#ffffff" },
            [BUILTIN.Collider]: { sensor: false },
            [BUILTIN.RigidBody]: { type: "dynamic", linvel: [0, 0, 0] },
          },
        },
      ],
    };
    const stops: DebugStop[] = [];
    const sim = await Simulation.create(p, "out", {
      realm: "r",
      debug: {
        settings: () => ({
          enabled: true,
          breakOnError: false,
          breakpoints: [],
          watches: [
            { id: "w", enabled: true, entity: "e", koko: BUILTIN.Transform, field: "position" },
          ],
        }),
        onPause: (s) => {
          stops.push(s);
          sim.debug?.resume(s.id);
        },
      },
    });
    try {
      await sim.stepDebug(0.1);
      expect(stops).toHaveLength(1);
      expect(stops[0]?.change?.source).toBe("物理演算");
      expect(stops[0]?.line).toBe(0);
    } finally {
      sim.dispose();
    }
  });
  it("代入の直後に前後の値を示し、同じ値では止まらない", async () => {
    const result = await run("c.n=1;\nc.n=1;\nc.n=2;");
    expect(result.error).toBeNull();
    expect(result.value).toBe(2);
    expect(result.stops.map((s) => [s.line, s.change?.oldValue, s.change?.newValue])).toEqual([
      [4, 0, 1],
      [6, 1, 2],
    ]);
  });
  it("同じ式で二度変わっても、それぞれの書き換えを捉える", async () => {
    const result = await run("(c.n=1,c.n=0);");
    expect(result.stops.map((s) => s.change?.newValue)).toEqual([1, 0]);
    expect(result.value).toBe(0);
  });
  it("前後の値を条件に使える", async () => {
    const result = await run("c.n=1;c.n=2;c.n=3;", "oldValue === 1 && newValue === 2");
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]?.change?.newValue).toBe(2);
  });
  it("world.set でも変更元の行で止まる", async () => {
    const result = await run("world.set(e.id,C,{n:4});");
    expect(result.error).toBeNull();
    expect(result.value).toBe(4);
    expect(result.stops[0]?.line).toBe(4);
    expect(result.stops[0]?.change?.newValue).toBe(4);
  });
});
