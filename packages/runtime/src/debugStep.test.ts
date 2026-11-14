import {
  type DebugSettings,
  emptyProject,
  type ProjectSnapshot,
  packageResourceId,
} from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import type { DebugStop } from "./debugRuntime";
import { Simulation } from "./simulation";

const source = `import C from "./Counter.koko";
function inc(value) {
return value+1;
}
export default system({query:{with:[C]},onUpdate(e){
const c=e.get(C);
let n=1;
n=inc(n);
c.n=n;
}});`;

async function create(
  twoEntities = false,
  noScripts = false,
  anotherSystem = false,
  code = source,
) {
  const project: ProjectSnapshot = {
    ...emptyProject("step"),
    kokostates: [
      {
        id: "counter",
        name: "Counter",
        fields: [{ id: "n", name: "n", type: "number", default: 0 }],
      },
    ],
    systems: [
      { id: "s", name: "s", code },
      ...(anotherSystem
        ? [
            {
              id: "next",
              name: "next",
              code: "export default system({onUpdate(e){\nlet next=1;\n}});",
            },
          ]
        : []),
    ],
    outputs: [
      {
        id: "out",
        name: "out",
        kind: "item",
        systems: noScripts
          ? []
          : [{ id: "s", enabled: true }, ...(anotherSystem ? [{ id: "next", enabled: true }] : [])],
        keep: [],
      },
    ],
    entities: (twoEntities ? ["e", "second"] : ["e"]).map((id) => ({
      id,
      name: id,
      parent: null,
      output: "out",
      order: 0,
      states: { counter: { n: 0 } },
    })),
  };
  const settings: DebugSettings = {
    enabled: true,
    breakOnError: false,
    watches: [],
    breakpoints: noScripts
      ? []
      : [
          {
            id: "point",
            systemId: "s",
            line: 8,
            enabled: true,
            kind: "breakpoint",
            condition: "",
            expression: "",
            entity: "",
          },
        ],
  };
  const queue: DebugStop[] = [];
  const waiters: ((stop: DebugStop) => void)[] = [];
  const sim = await Simulation.create(project, "out", {
    realm: "r",
    debug: {
      settings: () => settings,
      onPause: (stop) => {
        const waiter = waiters.shift();
        if (waiter) waiter(stop);
        else queue.push(stop);
      },
    },
  });
  const next = () => {
    const stop = queue.shift();
    return stop
      ? Promise.resolve(stop)
      : new Promise<DebugStop>((resolve) => waiters.push(resolve));
  };
  return { sim, next, settings };
}

describe("ステップ実行", () => {
  it("別のVMでフレームIDが重なっても次のSystemへ出る", async () => {
    const dep = { alias: "lib", packageId: "w_lib", version: 1, contentHash: "h" };
    const systemId = packageResourceId(dep, "b");
    const kokoId = packageResourceId(dep, "pc");
    const stops: DebugStop[] = [];
    const settings: DebugSettings = {
      enabled: true,
      breakOnError: false,
      watches: [],
      breakpoints: [
        {
          id: "p",
          systemId: "a",
          line: 3,
          enabled: true,
          kind: "breakpoint",
          condition: "",
          expression: "",
          entity: "",
        },
      ],
    };
    const sim = await Simulation.create(
      {
        ...emptyProject("realms"),
        dependencies: [dep],
        kokostates: [{ id: "lc", name: "LC", fields: [] }],
        systems: [
          {
            id: "a",
            name: "a",
            code: 'import C from "./LC.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nlet a=1;\n}});',
          },
        ],
        outputs: [
          {
            id: "out",
            name: "out",
            kind: "item",
            systems: [
              { id: "a", enabled: true },
              { id: systemId, enabled: true },
            ],
            keep: [],
          },
        ],
        entities: [
          {
            id: "e",
            name: "e",
            parent: null,
            output: "out",
            order: 0,
            states: { lc: {}, [kokoId]: {} },
          },
        ],
      },
      "out",
      {
        realm: "r",
        packages: [
          {
            status: "ready",
            dependency: dep,
            manifest: {
              format: 1,
              exports: [
                {
                  kind: "kokostate",
                  id: "pc",
                  path: "/PC.koko",
                  definition: { id: "pc", name: "PC", fields: [] },
                },
                {
                  kind: "system",
                  id: "b",
                  path: "/b.ts",
                  definition: {
                    id: "b",
                    name: "b",
                    code: 'import C from "./PC.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nlet b=1;\nb++;\n}});',
                  },
                },
              ],
            },
          },
        ],
        debug: {
          settings: () => settings,
          onPause: (stop) => {
            stops.push(stop);
            sim.debug?.resume(stop.id, stops.length === 1 ? "out" : "continue");
          },
        },
      },
    );
    try {
      await sim.stepDebug(0.1);
      expect(stops.map((s) => s.systemId)).toEqual(["a", systemId]);
      expect(sim.time).toBe(0.1);
    } finally {
      sim.dispose();
    }
  });
  it("同じ行に戻るループも一反復ずつ進む", async () => {
    const { sim, next, settings } = await create(
      false,
      false,
      false,
      `export default system({onUpdate(e){
let n=0;
while(n<3){
n++;
}
let finished=n;
}});`,
    );
    settings.breakpoints[0]!.line = 4;
    const run = sim.stepDebug(0.1);
    try {
      const first = await next();
      expect(first.line).toBe(4);
      sim.debug?.resume(first.id, "over");
      const second = await next();
      expect(second.line).toBe(4);
      expect(second.frames[0]?.variables.find((v) => v.name === "n")?.value).toBe(1);
    } finally {
      sim.dispose();
      await run;
    }
  });
  it("ボタンの一時停止は実行中のフレームを終えてから止まる", async () => {
    const { sim, next, settings } = await create();
    settings.breakpoints = [];
    sim.debug?.requestPause();
    const run = sim.stepDebug(0.1);
    try {
      const stop = await next();
      expect(stop.line).toBe(0);
      expect(stop.frames).toEqual([]);
      expect(sim.world.get("e", "counter")?.n).toBe(2);
      expect(sim.time).toBe(0.1);
    } finally {
      sim.dispose();
      await run;
    }
  });
  it("呼び出しの終わりを越えたら同じフレームの次のSystemへ進む", async () => {
    const { sim, next } = await create(false, false, true);
    const run = sim.stepDebug(0.1);
    try {
      const first = await next();
      sim.debug?.resume(first.id, "out");
      const nextSystem = await next();
      expect(nextSystem.systemId).toBe("next");
      expect(nextSystem.line).toBe(2);
      expect(sim.time).toBe(0.1);
    } finally {
      sim.dispose();
      await run;
    }
  });
  it("関数の中へ入り、関数から出る", async () => {
    const { sim, next } = await create();
    const run = sim.stepDebug(0.1);
    try {
      const first = await next();
      expect(first.line).toBe(8);
      sim.debug?.resume(first.id, "into");
      const inner = await next();
      expect(inner.line).toBe(3);
      expect(inner.frames).toHaveLength(2);
      sim.debug?.resume(inner.id, "out");
      const outer = await next();
      expect(outer.line).toBe(9);
      expect(outer.frames).toHaveLength(1);
      sim.debug?.resume(outer.id);
      await run;
      expect(sim.world.get("e", "counter")?.n).toBe(2);
    } finally {
      sim.dispose();
      await run;
    }
  });
  it("次の行へは関数の呼び出しを飛び越す", async () => {
    const { sim, next } = await create();
    const run = sim.stepDebug(0.1);
    try {
      const first = await next();
      sim.debug?.resume(first.id, "over");
      const after = await next();
      expect(after.line).toBe(9);
      expect(after.frames).toHaveLength(1);
      expect(after.frames[0]?.variables.find((v) => v.name === "n")?.value).toBe(2);
    } finally {
      sim.dispose();
      await run;
    }
  });
  it("呼び出しの外へ出たら同じフレームの次のEntityで止まる", async () => {
    const { sim, next } = await create(true);
    const run = sim.stepDebug(0.1);
    try {
      const first = await next();
      sim.debug?.resume(first.id, "out");
      const second = await next();
      expect(second.entity).not.toBe(first.entity);
      expect(second.line).toBe(6);
      expect(sim.time).toBe(0.1);
    } finally {
      sim.dispose();
      await run;
    }
  });
  it("同じフレームに次がなければ次のフレームへ進む", async () => {
    const { sim, next } = await create();
    let run = sim.stepDebug(0.1);
    try {
      const first = await next();
      sim.debug?.resume(first.id, "out");
      await run;
      run = sim.stepDebug(0.1);
      const second = await next();
      expect(second.line).toBe(6);
      expect(sim.time).toBe(0.2);
    } finally {
      sim.dispose();
      await run;
    }
  });
  it("次のフレームまでは途中の条件を飛び越してフレームの先頭で止まる", async () => {
    const { sim, next } = await create();
    let run = sim.stepDebug(0.1);
    try {
      const first = await next();
      sim.debug?.resume(first.id, "frame");
      await run;
      run = sim.stepDebug(0.1);
      const boundary = await next();
      expect(boundary.reason).toBe("次のフレーム");
      expect(boundary.frames).toEqual([]);
      expect(sim.time).toBe(0.1);
      expect(sim.world.get("e", "counter")?.n).toBe(2);
      sim.debug?.resume(boundary.id, "over");
      const firstStatement = await next();
      expect(firstStatement.line).toBe(6);
    } finally {
      sim.dispose();
      await run;
    }
  });
  it("スクリプトがない場合もボタンで一時停止し、ステップできる", async () => {
    const { sim, next } = await create(false, true);
    let run: Promise<void>;
    sim.debug?.requestPause();
    run = sim.stepDebug(0.1);
    try {
      const first = await next();
      expect(first.reason).toBe("フレームの切れ目");
      sim.debug?.resume(first.id, "into");
      await run;
      run = sim.stepDebug(0.1);
      const second = await next();
      expect(second.reason).toBe("フレームの切れ目");
      expect(sim.time).toBe(0.2);
    } finally {
      sim.dispose();
      await run;
    }
  });
});
