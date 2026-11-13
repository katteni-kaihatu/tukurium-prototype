import { afterEach, describe, expect, it } from "vitest";
import { type ScriptEntity, ScriptError, ScriptSandbox } from "./sandbox";

// import した KokoState は、コンパイラが __koko(ID, 名前) に書き換える（ここでは直接書く）
const SHOOT = `
const Gun = __koko("Gun", "Gun");
const Transform = __koko("Transform", "Transform");
const Disabled = __koko("Disabled", "Disabled");
export default system({
  query: { with: [Gun, Transform], without: [Disabled] },
  onUpdate(e, dt) {
    const gun = e.get(Gun);
    gun.cooldown = Math.max(0, gun.cooldown - dt);
  },
  onInput(e, ev) {
    const gun = e.get(Gun);
    if (ev.action === "fire" && gun.ammo > 0 && gun.cooldown === 0) {
      gun.ammo -= 1;
      gun.cooldown = gun.interval;
      const hit = world.raycast(e.get(Transform).position, [0, 0, 1], 100);
      if (hit) world.emit(hit.entity, "hit", { damage: 1 });
    }
  },
});
`;

const gun = (id: string, ammo = 2): ScriptEntity => ({
  id,
  states: {
    Gun: { ammo, interval: 0.5, cooldown: 0 },
    Transform: { position: [0, 1, 0] },
  },
});

let sandbox: ScriptSandbox | undefined;
afterEach(() => {
  sandbox?.dispose();
  sandbox = undefined;
});

describe("ScriptSandbox", () => {
  it("Query とハンドラを読み取り、値の変更を返す", async () => {
    const emitted: unknown[] = [];
    sandbox = await ScriptSandbox.create({
      hostFunctions: {
        "world.raycast": () => ({ entity: "target", distance: 3 }),
        "world.emit": (args, ctx) => {
          emitted.push([...args, ctx]);
          return undefined;
        },
      },
    });
    const meta = sandbox.loadSystem("shoot", SHOOT);
    expect(meta.query).toEqual({ with: ["Gun", "Transform"], without: ["Disabled"] });
    expect(meta.handlers.sort()).toEqual(["onInput", "onUpdate"]);

    let es = sandbox.run("shoot", "onInput", [gun("g1")], [{ action: "fire" }]);
    expect(es[0]?.states.Gun).toEqual({ ammo: 1, interval: 0.5, cooldown: 0.5 });
    expect(emitted).toEqual([
      // 呼び出したときに処理していた Entity も渡る（どの配置のための呼び出しかを決める）
      ["target", "hit", { damage: 1 }, { realm: "default", systemId: "shoot", entity: "g1" }],
    ]);

    es = sandbox.run("shoot", "onUpdate", es, [0.2]);
    expect(es[0]?.states.Gun?.cooldown).toBeCloseTo(0.3);
  });

  it("ページのグローバルには触れられない", async () => {
    sandbox = await ScriptSandbox.create();
    sandbox.loadSystem(
      "peek",
      `const Out = __koko("out", "out");
      export default system({ query: { with: [Out] }, onUpdate(e) {
        Object.assign(e.get(Out), { fetch: typeof fetch, process: typeof process, window: typeof window, require: typeof require });
      } });`,
    );
    const [e] = sandbox.run("peek", "onUpdate", [{ id: "x", states: { out: {} } }]);
    expect(e?.states.out).toEqual({
      fetch: "undefined",
      process: "undefined",
      window: "undefined",
      require: "undefined",
    });
  });

  it("無限ループを時間制限で止め、その後も VM を使い続けられる", async () => {
    sandbox = await ScriptSandbox.create({ timeLimitMs: 30 });
    sandbox.loadSystem("loop", `export default system({ onUpdate() { while (true) {} } });`);
    const t0 = performance.now();
    expect(() => sandbox?.run("loop", "onUpdate", [gun("g")])).toThrowError(
      expect.objectContaining({ kind: "timeout" }),
    );
    expect(performance.now() - t0).toBeLessThan(1000);

    sandbox.loadSystem("shoot", SHOOT);
    const es = sandbox.run("shoot", "onUpdate", [gun("g")], [0.1]);
    expect(es).toHaveLength(1);
  });

  it("読み込み時の無限ループも止める", async () => {
    sandbox = await ScriptSandbox.create({ timeLimitMs: 30, loadTimeLimitMs: 50 });
    expect(() => sandbox?.loadSystem("bad", "for(;;){} export default system({});")).toThrow(
      ScriptError,
    );
  });

  it("メモリの使いすぎを止める", async () => {
    sandbox = await ScriptSandbox.create({ memoryLimitBytes: 8 * 1024 * 1024, timeLimitMs: 2000 });
    sandbox.loadSystem(
      "hog",
      `export default system({ onUpdate() { const a = []; while (true) a.push(new Array(10000).fill(1)); } });`,
    );
    const t0 = performance.now();
    expect(() => sandbox?.run("hog", "onUpdate", [gun("g")])).toThrowError(
      expect.objectContaining({ kind: "memory" }),
    );
    // 時間制限（2秒）より前に、メモリ監視で止まっている
    expect(performance.now() - t0).toBeLessThan(1900);
    expect(sandbox.broken).toBe(true);
  });

  it("オブジェクトを大量に作るとメモリ上限で止まる（VM は使い続けられる）", async () => {
    sandbox = await ScriptSandbox.create({ memoryLimitBytes: 8 * 1024 * 1024, timeLimitMs: 2000 });
    sandbox.loadSystem(
      "hog",
      `export default system({ onUpdate() { const a = []; while (true) a.push({ x: 1 }); } });`,
    );
    expect(() => sandbox?.run("hog", "onUpdate", [gun("g")])).toThrowError(
      expect.objectContaining({ kind: "memory" }),
    );
  });

  it("構文エラーを load エラーとして返す", async () => {
    sandbox = await ScriptSandbox.create();
    expect(() => sandbox?.loadSystem("bad", "export default system({ onUpdate( }")).toThrowError(
      expect.objectContaining({ kind: "load", systemId: "bad" }),
    );
  });

  it("エラーにスクリプトの行番号を付ける（構文エラー・実行時の例外）", async () => {
    sandbox = await ScriptSandbox.create();
    const bad =
      "export default system({\n  query: { with: [] },\n  onUpdate() {\n    const x = ;\n  },\n});";
    expect(() => sandbox?.loadSystem("s1", bad)).toThrowError(expect.objectContaining({ line: 4 }));
    sandbox.loadSystem(
      "s2",
      "export default system({\n  query: { with: [] },\n  onUpdate() {\n\n    foo.bar();\n  },\n});",
    );
    expect(() => sandbox?.run("s2", "onUpdate", [{ id: "e", states: {} }], [0])).toThrowError(
      expect.objectContaining({ kind: "runtime", line: 5 }),
    );
  });

  it("log を受け取れる", async () => {
    const logs: [string | null, string][] = [];
    sandbox = await ScriptSandbox.create({ onLog: (m, ctx) => logs.push([ctx.systemId, m]) });
    sandbox.loadSystem(
      "hello",
      `export default system({ onUpdate(e) { log("hi", e.id, { a: 1 }); } });`,
    );
    sandbox.run("hello", "onUpdate", [{ id: "e1", states: {} }]);
    expect(logs).toEqual([["hello", 'hi e1 {"a":1}']]);
  });

  it("広げた値（undefined・Date・Map・Set・bigint・NaN）が、ホストとの間をそのまま行き来する（ADR 0065）", async () => {
    const seen: unknown[] = [];
    const logs: string[] = [];
    sandbox = await ScriptSandbox.create({
      onLog: (m) => logs.push(m),
      hostFunctions: {
        "world.get": () => ({
          at: new Date(5),
          ids: new Set(["a"]),
          none: undefined,
          big: 2n ** 70n,
        }),
        "world.emit": (args) => {
          seen.push(args);
          return undefined;
        },
      },
    });
    sandbox.loadSystem(
      "rich",
      `const Card = __koko("Card", "Card");
      export default system({
        query: { with: [Card] },
        onUpdate(e, arg) {
          const c = e.get(Card);
          const got = world.get();
          world.emit([
            c.board instanceof Map, c.board.get(7), c.at instanceof Date, c.at.getTime(),
            typeof c.big, "none" in c, c.none, Number.isNaN(c.nan), c.inf, c.tags.has("x"),
            arg.when instanceof Date, got.at.getTime(), got.ids.has("a"), "none" in got, got.big,
          ]);
          // スクリプトの中で足し、計算して返す
          c.board.set("b2", { kind: "rook" });
          c.big = c.big * 2n;
          c.at = new Date(c.at.getTime() + 1000);
          c.tags.add(undefined);
          c.none = new Map([[1n, NaN]]);
          c.gone = undefined;
          log(1n, new Set([1]), undefined);
        },
      });`,
    );
    const before: ScriptEntity = {
      id: "e",
      states: {
        Card: {
          board: new Map<number, string>([[7, "seven"]]),
          at: new Date(1000),
          big: 2n ** 64n,
          none: undefined,
          nan: Number.NaN,
          inf: Number.NEGATIVE_INFINITY,
          tags: new Set(["x"]),
          gone: "x",
        },
      },
    };
    const [after] = sandbox.run("rich", "onUpdate", [before], [{ when: new Date(0) }]);
    expect(seen).toEqual([
      [
        [
          true,
          "seven",
          true,
          1000,
          "bigint",
          true,
          undefined,
          true,
          Number.NEGATIVE_INFINITY,
          true,
          true,
          5,
          true,
          true,
          2n ** 70n,
        ],
      ],
    ]);
    const card = after?.states.Card ?? {};
    expect(card.board).toEqual(
      new Map<unknown, unknown>([
        [7, "seven"],
        ["b2", { kind: "rook" }],
      ]),
    );
    expect(card.big).toBe(2n ** 65n);
    expect(card.at).toEqual(new Date(2000));
    expect(card.tags).toEqual(new Set(["x", undefined]));
    expect(card.none).toEqual(new Map([[1n, Number.NaN]]));
    expect("gone" in card).toBe(true);
    expect(card.gone).toBeUndefined();
    expect(Number.isNaN(card.nan)).toBe(true);
    expect(logs).toEqual(['{"$t":"bigint","v":"1"} {"$t":"Set","v":[1]} undefined']);
  });

  it("値の形式で運ぶフィールドを絞っても、そのフィールドの値は欠けない（ADR 0065）", async () => {
    sandbox = await ScriptSandbox.create();
    sandbox.loadSystem(
      "s",
      `const K = __koko("K", "K");
      export default system({
        query: { with: [K] },
        onUpdate(e) {
          const k = e.get(K);
          k.seen = [k.ref === undefined && "ref" in k, k.at instanceof Date, k.n].join();
          if (e.id === "a") {
            k.ref = undefined;        // 指定したフィールド：undefined をそのまま返す
            k.other = new Map([[1, 2n]]);
            k.n = undefined;          // 指定していないフィールド：書かなかったのと同じ
            k.text = NaN;             // null になる
          } else {
            k.ref = "e1";
            k.n = 5n;                 // bigint は null になる（投げない）
            k.text = { $t: "Date", v: "2026-11-10T00:00:00.000Z" }; // タグとして読まれない
            delete k.other;
          }
        },
      });`,
    );
    const state = (ref: string | undefined) => ({
      ref,
      other: "x",
      n: 1,
      text: "t",
      // 指定していなくても、渡す値にタグが要るフィールドは値の形式で運ぶ
      at: new Date(3),
      seen: "",
    });
    const out = sandbox.run(
      "s",
      "onUpdate",
      [
        { id: "a", states: { K: state("e9") } },
        { id: "b", states: { K: state(undefined) } },
      ],
      [],
      { K: ["ref", "other"] },
    );
    const a = out[0]?.states.K ?? {};
    const b = out[1]?.states.K ?? {};
    expect(a.seen).toBe("false,true,1");
    expect(b.seen).toBe("true,true,1");
    expect("ref" in a).toBe(true);
    expect(a.ref).toBeUndefined();
    expect(a.other).toEqual(new Map([[1, 2n]]));
    expect("n" in a).toBe(false);
    expect(a.text).toBeNull();
    expect(a.at).toEqual(new Date(3));
    expect(b.ref).toBe("e1");
    expect(b.n).toBeNull();
    expect(b.text).toEqual({ $t: "Date", v: "2026-11-10T00:00:00.000Z" });
    expect("other" in b).toBe(false);
  });

  it("別の領域の System は、グローバルやプロトタイプの書き換えが届かない", async () => {
    sandbox = await ScriptSandbox.create();
    sandbox.loadSystem(
      "evil",
      `const define = system;
       Object.prototype.hacked = true;
       globalThis.system = () => { throw new Error("hijacked"); };
       export default define({ onUpdate() {} });`,
      "repo-evil",
    );
    sandbox.loadSystem(
      "victim",
      `const Out = __koko("out", "out"); export default system({ query: { with: [Out] }, onUpdate(e) { e.get(Out).hacked = ({}).hacked === true; } });`,
      "repo-victim",
    );
    const [v] = sandbox.run("victim", "onUpdate", [{ id: "x", states: { out: {} } }]);
    expect(v?.states.out).toEqual({ hacked: false });
    // 同じ領域なら書き換えが見える（同じ作者の System はグローバルを共有する）
    expect(() =>
      sandbox?.loadSystem("same", "export default system({});", "repo-evil"),
    ).toThrowError(/hijacked/);
  });

  it("Query に名前の文字列は書けない。e.get() で触れるのは Query の with に書いた KokoState だけ（ADR 0058）", async () => {
    sandbox = await ScriptSandbox.create();
    expect(() =>
      sandbox?.loadSystem("named", `export default system({ query: { with: ["Gun"] } });`),
    ).toThrowError(/名前の文字列は使えません/);
    sandbox.loadSystem(
      "peek",
      `const Gun = __koko("Gun", "Gun");
       const Hp = __koko("Hp", "Hp");
       export default system({ query: { with: [Gun] }, onUpdate(e) { e.get(Hp); } });`,
    );
    expect(() =>
      sandbox?.run("peek", "onUpdate", [{ id: "x", states: { Gun: {}, Hp: { hp: 1 } } }]),
    ).toThrowError(/Hp」はこの System の query.with にない/);
  });

  it("System を別の領域へ読み込み直すと、元の領域からは消える", async () => {
    sandbox = await ScriptSandbox.create();
    const sys = (v: number) =>
      `const Out = __koko("out", "out"); export default system({ query: { with: [Out] }, onUpdate(e) { e.get(Out).v = ${v}; } });`;
    sandbox.loadSystem("s", sys(1), "a");
    sandbox.loadSystem("s", sys(2), "b");
    const [e] = sandbox.run("s", "onUpdate", [{ id: "x", states: { out: {} } }]);
    expect(e?.states.out).toEqual({ v: 2 });
    sandbox.disposeRealm("b");
    expect(() => sandbox?.run("s", "onUpdate", [])).toThrowError(/読み込まれていません/);
  });

  it("性能の目安：500 Entity の onUpdate を 1 回の呼び出しで処理", async () => {
    sandbox = await ScriptSandbox.create({ timeLimitMs: 1000 });
    sandbox.loadSystem("shoot", SHOOT);
    const es = Array.from({ length: 500 }, (_, i) => gun(`g${i}`));
    sandbox.run("shoot", "onUpdate", es, [0.016]); // ウォームアップ
    const n = 30;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) sandbox.run("shoot", "onUpdate", es, [0.016]);
    const per = (performance.now() - t0) / n;
    console.info(`[perf] 500 entities onUpdate: ${per.toFixed(2)} ms/call`);
    expect(per).toBeLessThan(100);
  });
});
