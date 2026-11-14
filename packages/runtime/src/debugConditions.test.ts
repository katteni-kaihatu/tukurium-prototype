import { type DebugSettings, emptyProject } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import type { DebugStop } from "./debugRuntime";
import { Simulation } from "./simulation";

const project = (code: string) => ({
  ...emptyProject("conditions"),
  systems: [{ id: "s", name: "S", code }],
  outputs: [
    {
      id: "out",
      name: "Out",
      kind: "item" as const,
      systems: [{ id: "s", enabled: true }],
      keep: [],
    },
  ],
  entities: ["a", "b"].map((id) => ({
    id,
    name: id,
    parent: null,
    output: "out",
    order: 0,
    states: {},
  })),
});
const settings = (): DebugSettings => ({
  enabled: true,
  breakOnError: false,
  watches: [],
  breakpoints: [
    {
      id: "p",
      systemId: "s",
      line: 4,
      enabled: true,
      kind: "breakpoint",
      condition: "n === 2",
      expression: "",
      entity: "a",
    },
  ],
});
const code = `export default system({onUpdate(e){
let n=0;
for(let i=0;i<3;i++){
n++;
}
}});`;

describe("絞り込みとログポイント", () => {
  it.each([
    ["[,][0] === undefined", true],
    ["arr.length === 3", true],
    ["a === box.a", false],
  ])("配列長と比較の制限を守る: %s", async (condition, stopsExpected) => {
    const config = settings();
    config.breakpoints[0]!.condition = condition;
    let count = 0;
    const logs: string[] = [];
    const sim = await Simulation.create(
      project(`export default system({onUpdate(e){
const arr=new Array(3);const a={};const box={a};
let n=0;
n++;
}});`),
      "out",
      {
        realm: "r",
        onLog: (e) => logs.push(e.message),
        debug: {
          settings: () => config,
          onPause: (s) => {
            count++;
            sim.debug?.resume(s.id);
          },
        },
      },
    );
    try {
      await sim.stepDebug(0.1);
      expect(count).toBe(stopsExpected ? 1 : 0);
      if (!stopsExpected) expect(logs.some((s) => s.includes("同一性は比較できません"))).toBe(true);
    } finally {
      sim.dispose();
    }
  });
  it("Proxyのtrapを条件式から実行しない", async () => {
    const config = settings();
    config.breakpoints[0]!.condition = "obj.x === 1";
    const logs: string[] = [];
    const sim = await Simulation.create(
      project(`export default system({onUpdate(e){
let n=0;
const obj=new Proxy({}, {getOwnPropertyDescriptor(t,k){if(k==='x'){n++;return {value:1,configurable:true};}}});
log('n='+n);
}});`),
      "out",
      {
        realm: "r",
        onLog: (e) => logs.push(e.message),
        debug: { settings: () => config, onPause: (s) => sim.debug?.resume(s.id) },
      },
    );
    try {
      await sim.stepDebug(0.1);
      expect(logs.every((s) => s === "n=0")).toBe(true);
    } finally {
      sim.dispose();
    }
  });
  it("optional chain の短絡を次のフィールド参照まで保つ", async () => {
    const config = settings();
    config.breakpoints[0]!.condition = "obj?.x.y === undefined";
    let count = 0;
    const sim = await Simulation.create(
      project(`export default system({onUpdate(e){
const obj=null;
let n=0;
n++;
}});`),
      "out",
      {
        realm: "r",
        debug: {
          settings: () => config,
          onPause: (s) => {
            count++;
            sim.debug?.resume(s.id);
          },
        },
      },
    );
    try {
      await sim.stepDebug(0.1);
      expect(count).toBe(1);
    } finally {
      sim.dispose();
    }
  });
  it("Entity と式を両方満たすときだけ止まる", async () => {
    const stops: DebugStop[] = [];
    const sim = await Simulation.create(project(code), "out", {
      realm: "r",
      debug: {
        settings,
        onPause: (s) => {
          stops.push(s);
          sim.debug?.resume(s.id);
        },
      },
    });
    try {
      await sim.stepDebug(0.1);
      expect(stops).toHaveLength(1);
      expect(stops[0]?.entity).toBe("a");
      expect(stops[0]?.frames[0]?.variables.find((v) => v.name === "n")?.value).toBe(2);
    } finally {
      sim.dispose();
    }
  });
  it("ログポイントは止めず、条件と同じスコープで式を読む", async () => {
    const config = settings();
    config.breakpoints[0]!.kind = "logpoint";
    config.breakpoints[0]!.expression = "[e.id,n]";
    const logs: string[] = [];
    const sim = await Simulation.create(project(code), "out", {
      realm: "r",
      onLog: (e) => logs.push(e.message),
      debug: {
        settings: () => config,
        onPause: () => {
          throw Error("停止しない");
        },
      },
    });
    try {
      await sim.stepDebug(0.1);
      expect(logs).toEqual(['4 行目：["a",2]']);
    } finally {
      sim.dispose();
    }
  });
  it("編集中の条件は次のフレームから使う", async () => {
    const config = settings();
    config.breakpoints[0]!.condition = "";
    config.breakpoints[0]!.entity = "a";
    const stops: DebugStop[] = [];
    const sim = await Simulation.create(project(code), "out", {
      realm: "r",
      debug: {
        settings: () => config,
        onPause: (s) => {
          stops.push(s);
          config.breakpoints[0]!.enabled = false;
          sim.debug?.resume(s.id);
        },
      },
    });
    try {
      await sim.stepDebug(0.1);
      expect(stops).toHaveLength(3);
      await sim.stepDebug(0.1);
      expect(stops).toHaveLength(3);
    } finally {
      sim.dispose();
    }
  });
  it("getter と暗黙の型変換で利用者の処理を呼ばない", async () => {
    const config = settings();
    config.breakpoints[0]!.line = 4;
    config.breakpoints[0]!.condition = "obj.n > 0";
    const logs: string[] = [];
    const sim = await Simulation.create(
      project(`export default system({onUpdate(e){
let obj={get n(){log('getter called');return 1;}};
let n=1;
n++;
}});`),
      "out",
      {
        realm: "r",
        onLog: (e) => logs.push(e.message),
        debug: {
          settings: () => config,
          onPause: () => {
            throw Error("停止しない");
          },
        },
      },
    );
    try {
      await sim.stepDebug(0.1);
      expect(logs.some((s) => s.includes("getter called"))).toBe(false);
      expect(logs.some((s) => s.includes("この位置では読めません"))).toBe(true);
    } finally {
      sim.dispose();
    }
  });
});
