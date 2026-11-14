import { encodeValue } from "@tukurium/eks";
import { type DebugSettings, emptyProject, type ProjectSnapshot } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import type { DebugStop } from "./debugRuntime";
import { Simulation } from "./simulation";

export const debugProject = (
  code = `import C from "./Counter.koko";
export default system({query:{with:[C]},onUpdate(e){
const c=e.get(C);
c.n+=1;
c.n+=2;
}});`,
): ProjectSnapshot => ({
  ...emptyProject("debug"),
  kokostates: [
    {
      id: "counter",
      name: "Counter",
      fields: [{ id: "n", name: "n", type: "number", default: 0 }],
    },
  ],
  systems: [{ id: "s", name: "S", code }],
  outputs: [
    {
      id: "out",
      name: "out",
      kind: "item" as const,
      systems: [{ id: "s", enabled: true }],
      keep: [],
    },
  ],
  entities: [
    { id: "e", name: "E", output: "out", parent: null, order: 0, states: { counter: { n: 0 } } },
  ],
});
export const settings = (line = 5): DebugSettings => ({
  enabled: true,
  breakOnError: false,
  watches: [],
  breakpoints: [
    {
      id: "p",
      systemId: "s",
      line,
      enabled: true,
      kind: "breakpoint",
      condition: "",
      expression: "",
      entity: "",
    },
  ],
});

describe("待てるフレーム", () => {
  it("引数を初期化している途中に関数を呼んでも、デバッグ情報の取得で停止しない", async () => {
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);const fn=(n=1,v=(()=>n)())=>{c.n=v;};fn();\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: {
        settings: () => ({ ...settings(), breakpoints: [] }),
        onPause: () => {
          throw new Error("unexpected pause");
        },
      },
    });
    try {
      await sim.stepDebug(0.1);
      expect(sim.systemStatus()[0]?.error).toBeNull();
      expect(sim.world.get("e", "counter")?.n).toBe(1);
    } finally {
      sim.dispose();
    }
  });
  it("既定値とrestを持つ矢印関数でもrest変数の再代入で停止しない", async () => {
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);const fn=(n=1,...args)=>{args=null;c.n=n;};fn();\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: {
        settings: () => ({ ...settings(), breakpoints: [] }),
        onPause: () => {
          throw new Error("unexpected pause");
        },
      },
    });
    try {
      await sim.stepDebug(0.1);
      expect(sim.systemStatus()[0]?.error).toBeNull();
      expect(sim.world.get("e", "counter")?.n).toBe(1);
    } finally {
      sim.dispose();
    }
  });
  it.each([false, true, "trailing"])(
    "返された既定引数のクロージャーを別の呼び出しとして編集する（arrow=%s）",
    async (arrow) => {
      let reached!: (stop: DebugStop) => void;
      const paused = new Promise<DebugStop>((resolve) => {
        reached = resolve;
      });
      const start = arrow ? "const make=(n,cb=()=>{" : "function make(n,cb=()=>{";
      const end = arrow === "trailing" ? "},)=>cb;" : arrow ? "})=>cb;" : "}){return cb;}";
      const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nlet second;\n${start}\nif(n===1)second();\nelse c.n=n;\n${end}\nconst first=make(1);\nsecond=make(2);\nfirst();\n}});`;
      const sim = await Simulation.create(debugProject(code), "out", {
        realm: "r",
        debug: { settings: () => settings(7), onPause: reached },
      });
      try {
        const run = sim.stepDebug(0.1);
        const stop = await paused;
        const first = stop.frames[1],
          second = stop.frames[2];
        if (!first || !second) throw new Error("frames missing");
        expect(sim.debug?.edit(stop.id, { frameId: first.id, name: "n", value: 7 })).toBe(true);
        expect(
          sim.debug?.stop?.frames
            .slice(1)
            .map((f) => f.variables.find((v) => v.name === "n")?.value),
        ).toEqual([7, 2]);
        expect(sim.debug?.edit(stop.id, { frameId: second.id, name: "n", value: 8 })).toBe(true);
        sim.debug?.resume(stop.id);
        await run;
        expect(sim.world.get("e", "counter")?.n).toBe(8);
      } finally {
        sim.dispose();
      }
    },
  );
  it.each(["for(let n=1;n<=2;n++){", "for(let n of [1,2]){", "for(let i=1;i<=2;i++){let n=i;"])(
    "ループの別周回の束縛を混ぜずに編集する: %s",
    async (header) => {
      let reached!: (stop: DebugStop) => void;
      const paused = new Promise<DebugStop>((resolve) => {
        reached = resolve;
      });
      const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nconst callbacks=[];\n${header}\ncallbacks.push(()=>{\nif(n===1)callbacks[1]();\nelse c.n=n;\n});\n}\ncallbacks[0]();\n}});`;
      const sim = await Simulation.create(debugProject(code), "out", {
        realm: "r",
        debug: { settings: () => settings(8), onPause: reached },
      });
      try {
        const run = sim.stepDebug(0.1);
        const stop = await paused;
        const outer = stop.frames[1],
          inner = stop.frames[2];
        if (!outer || !inner) throw new Error("frames missing");
        expect(sim.debug?.edit(stop.id, { frameId: outer.id, name: "n", value: 7 })).toBe(true);
        expect(
          sim.debug?.stop?.frames
            .slice(1)
            .map((f) => f.variables.find((v) => v.name === "n")?.value),
        ).toEqual([7, 2]);
        expect(sim.debug?.edit(stop.id, { frameId: inner.id, name: "n", value: 8 })).toBe(true);
        sim.debug?.resume(stop.id);
        await run;
        expect(sim.world.get("e", "counter")?.n).toBe(8);
      } finally {
        sim.dispose();
      }
    },
  );
  it("既定引数が捕捉した引数とbodyのvarを別の束縛として編集する", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nfunction outer(n=1,cb=()=>{\nc.n=n;\n}) {\nvar n=2;\ncb();\n}\nouter();\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: { settings: () => settings(5), onPause: reached },
    });
    try {
      const run = sim.stepDebug(0.1);
      const stop = await paused;
      const outer = stop.frames[1];
      if (!outer) throw new Error("frame missing");
      expect(sim.debug?.edit(stop.id, { frameId: outer.id, name: "n", value: 7 })).toBe(true);
      expect(
        sim.debug?.stop?.frames.slice(1).map((f) => f.variables.find((v) => v.name === "n")?.value),
      ).toEqual([7, 1]);
      sim.debug?.resume(stop.id);
      await run;
      expect(sim.world.get("e", "counter")?.n).toBe(1);
    } finally {
      sim.dispose();
    }
  });
  it.each([false, true])(
    "同じ束縛のコピーをそろえ、別のスコープは変えない（shadow=%s）",
    async (shadow) => {
      let reached!: (stop: DebugStop) => void;
      const paused = new Promise<DebugStop>((resolve) => {
        reached = resolve;
      });
      const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nlet n=1;\nfunction inner(){\n${shadow ? "let n=2;" : ""}\nc.n=n;\n}\ninner();\n}});`;
      const sim = await Simulation.create(debugProject(code), "out", {
        realm: "r",
        debug: { settings: () => settings(7), onPause: reached },
      });
      try {
        const run = sim.stepDebug(0.1);
        const stop = await paused;
        const outer = stop.frames[0],
          inner = stop.frames[1];
        if (!outer || !inner) throw new Error("frames missing");
        expect(sim.debug?.edit(stop.id, { frameId: outer.id, name: "n", value: 7 })).toBe(true);
        expect(
          sim.debug?.stop?.frames.map((f) => f.variables.find((v) => v.name === "n")?.value),
        ).toEqual([7, shadow ? 2 : 7]);
        sim.debug?.resume(stop.id);
        await run;
        expect(sim.world.get("e", "counter")?.n).toBe(shadow ? 2 : 7);
      } finally {
        sim.dispose();
      }
    },
  );
  it.each([null, { n: 10 }])(
    "stateを指していた変数を置換しても、その後のstate編集が壊れない: %j",
    async (replacement) => {
      let reached!: (stop: DebugStop) => void;
      const paused = new Promise<DebugStop>((resolve) => {
        reached = resolve;
      });
      const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nlet c=e.get(C);\nc.n=1;\nif(c){\nc.n+=2;\n}\n}});`;
      const sim = await Simulation.create(debugProject(code), "out", {
        realm: "r",
        debug: { settings: () => settings(5), onPause: reached },
      });
      try {
        const run = sim.stepDebug(0.1);
        const stop = await paused;
        const frame = stop.frames.at(-1);
        if (!frame) throw new Error("frame missing");
        expect(
          sim.debug?.edit(stop.id, {
            frameId: frame.id,
            name: "c",
            value: encodeValue(replacement),
          }),
        ).toBe(true);
        expect(
          sim.debug?.edit(stop.id, {
            kind: "state",
            entity: "e",
            koko: "counter",
            field: "n",
            value: 5,
          }),
        ).toBe(true);
        expect(
          sim.debug?.stop?.frames.at(-1)?.variables.find((v) => v.name === "c")?.value,
        ).toEqual(replacement);
        sim.debug?.resume(stop.id);
        await run;
        expect(sim.world.get("e", "counter")?.n).toBe(5);
      } finally {
        sim.dispose();
      }
    },
  );
  it("Date・Map・Setの値を見て変更し、その型のまま再開する", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nlet date=new Date('2026-01-01T00:00:00Z');\nlet map=new Map([['a',2]]);\nlet set=new Set([3]);\nc.n=date.getUTCDate()+map.get('a')+[...set][0];\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: { settings: () => settings(7), onPause: reached },
    });
    try {
      const run = sim.stepDebug(0.1);
      const stop = await paused;
      const frame = stop.frames.at(-1);
      if (!frame) throw new Error("frame missing");
      expect(frame.variables.find((v) => v.name === "map")?.value).toEqual(
        encodeValue(new Map([["a", 2]])),
      );
      for (const [name, value] of [
        ["date", new Date("2026-01-03T00:00:00Z")],
        ["map", new Map([["a", 5]])],
        ["set", new Set([7])],
      ] as const)
        expect(
          sim.debug?.edit(stop.id, { frameId: frame.id, name, value: encodeValue(value) }),
        ).toBe(true);
      sim.debug?.resume(stop.id);
      await run;
      expect(sim.world.get("e", "counter")?.n).toBe(15);
    } finally {
      sim.dispose();
    }
  });
  it("値を見るためにgetterやtoJSONを実行しない", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nlet count=0;\nconst value={get change(){count++;return count;},toJSON(){count++;return 1;}};\nconst c=e.get(C);\nc.n=count;\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: { settings: () => settings(6), onPause: reached },
    });
    try {
      const run = sim.stepDebug(0.1);
      const stop = await paused;
      expect(stop.frames.at(-1)?.variables.find((v) => v.name === "count")?.value).toBe(0);
      expect(stop.frames.at(-1)?.variables.find((v) => v.name === "value")?.unavailable).toBe(true);
      sim.debug?.resume(stop.id);
      await run;
      expect(sim.world.get("e", "counter")?.n).toBe(0);
    } finally {
      sim.dispose();
    }
  });
  it("停止中に変数を直して続けると、その値で実行する。constは書き換えない", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nlet n=1;\nc.n=n;\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: { settings: () => settings(5), onPause: reached },
    });
    try {
      const run = sim.stepDebug(0.1);
      const stop = await paused;
      const frameId = stop.frames.at(-1)?.id;
      if (frameId === undefined) throw new Error("frame missing");
      expect(sim.debug?.edit(stop.id, { frameId, name: "c", value: null })).toBe(false);
      expect(sim.debug?.edit(stop.id, { frameId, name: "n", value: 7 })).toBe(true);
      expect(sim.debug?.stop?.frames.at(-1)?.variables.find((v) => v.name === "n")?.value).toBe(7);
      sim.debug?.resume(stop.id);
      await run;
      expect(sim.world.get("e", "counter")?.n).toBe(7);
    } finally {
      sim.dispose();
    }
  });
  it("フィールドのIDと名前が違っても、値を直して続ける。型違いは拒む", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const project = debugProject();
    const field = project.kokostates[0]?.fields[0];
    const entity = project.entities[0];
    if (!field || !entity) throw new Error("fixture missing");
    field.id = "amount";
    entity.states.counter = { amount: 0 };
    const sim = await Simulation.create(project, "out", {
      realm: "r",
      debug: { settings: () => settings(5), onPause: reached },
    });
    try {
      const run = sim.stepDebug(0.1);
      const stop = await paused;
      expect(
        sim.debug?.edit(stop.id, {
          kind: "state",
          entity: "e",
          koko: "counter",
          field: "amount",
          value: "invalid",
        }),
      ).toBe(false);
      expect(
        sim.debug?.edit(stop.id, {
          kind: "state",
          entity: "e",
          koko: "counter",
          field: "amount",
          value: 5,
        }),
      ).toBe(true);
      expect(sim.world.get("e", "counter")?.amount).toBe(5);
      expect(
        sim.debug?.stop?.frames.at(-1)?.variables.find((v) => v.name === "c")?.value,
      ).toMatchObject({ n: 5 });
      sim.debug?.resume(stop.id);
      await run;
      expect(sim.world.get("e", "counter")?.amount).toBe(7);
      expect(entity.states.counter?.amount).toBe(0);
    } finally {
      sim.dispose();
    }
  });
  it("終了の例外を利用者がcatchしても、以後の値とログを反映しない", async () => {
    const logs: string[] = [];
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nc.n=1;\ntry {\nc.n=2;\n} catch(err) { c.n=99; world.set(e.id,C,{n:88}); log('ran after dispose'); }\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      onLog: (e) => logs.push(e.message),
      debug: { settings: () => settings(6), onPause: () => sim.dispose() },
    });
    await sim.stepDebug(0.1);
    expect(sim.world.get("e", "counter")?.n).toBe(1);
    expect(logs).toEqual([]);
  });
  it("停止後に呼び出し前の値へ戻しても世界に反映する", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nc.n=1;\nc.n=0;\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: { settings: () => settings(5), onPause: reached },
    });
    try {
      const frame = sim.stepDebug(0.1);
      const stop = await paused;
      expect(sim.world.get("e", "counter")?.n).toBe(1);
      sim.debug?.resume(stop.id);
      await frame;
      expect(sim.world.get("e", "counter")?.n).toBe(0);
    } finally {
      sim.dispose();
    }
  });
  it("停止のための途中表示が再開後の Host API の読み取りを変えない", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\nc.n=1;\nc.n=world.get(e.id,C).n;\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: { settings: () => settings(5), onPause: reached },
    });
    try {
      const frame = sim.stepDebug(0.1);
      const stop = await paused;
      expect(sim.world.get("e", "counter")?.n).toBe(1);
      sim.debug?.resume(stop.id);
      await frame;
      expect(sim.world.get("e", "counter")?.n).toBe(0);
    } finally {
      sim.dispose();
    }
  });
  it("空行の条件は次の実行できる行で止まる。古い停止の操作は断る", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const code = `import C from "./Counter.koko";\nexport default system({query:{with:[C]},onUpdate(e){\nconst c=e.get(C);\n\nc.n+=2;\n}});`;
    const sim = await Simulation.create(debugProject(code), "out", {
      realm: "r",
      debug: { settings: () => settings(4), onPause: reached },
    });
    try {
      const frame = sim.stepDebug(0.1);
      const stop = await paused;
      expect(stop.line).toBe(5);
      expect(sim.debug?.resume("old-stop")).toBe(false);
      expect(sim.debug?.stop?.id).toBe(stop.id);
      sim.debug?.resume(stop.id);
      await frame;
      expect(sim.world.get("e", "counter")?.n).toBe(2);
    } finally {
      sim.dispose();
    }
  });
  it("文の途中の状態で止まり、続けると同じ呼び出しの残りを実行する", async () => {
    let reached!: (stop: DebugStop) => void;
    const paused = new Promise<DebugStop>((resolve) => {
      reached = resolve;
    });
    const sim = await Simulation.create(debugProject(), "out", {
      realm: "r",
      debug: { settings: () => settings(), onPause: reached },
    });
    try {
      expect(sim.systemStatus()[0]?.error).toBeNull();
      const frame = sim.stepDebug(0.1);
      const stop = await paused;
      expect(stop.line).toBe(5);
      expect(sim.world.get("e", "counter")?.n).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(sim.debug?.resume(stop.id)).toBe(true);
      await frame;
      expect(sim.world.get("e", "counter")?.n).toBe(3);
    } finally {
      sim.dispose();
    }
  });
  it("停止中でも破棄でき、実行中のハンドルを残さない", async () => {
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const sim = await Simulation.create(debugProject(), "out", {
      realm: "r",
      debug: { settings: () => settings(), onPause: reached },
    });
    const frame = sim.stepDebug(0.1);
    await paused;
    sim.dispose();
    await frame;
    expect(sim.debug?.stop).toBeNull();
    expect(sim.world.get("e", "counter")?.n).toBe(1);
  });
  it("通常の再生も同じ最終値になる", async () => {
    const sim = await Simulation.create(debugProject(), "out", { realm: "r" });
    try {
      sim.step(0.1);
      expect(sim.world.get("e", "counter")?.n).toBe(3);
    } finally {
      sim.dispose();
    }
  });
});
