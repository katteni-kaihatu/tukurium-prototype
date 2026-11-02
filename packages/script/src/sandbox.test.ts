import { afterEach, describe, expect, it } from "vitest";
import { type ScriptEntity, ScriptError, ScriptSandbox } from "./sandbox";

const SHOOT = `
export default system({
  query: { with: ["Gun", "Transform"], without: ["Disabled"] },
  onUpdate(e, dt) {
    e.Gun.cooldown = Math.max(0, e.Gun.cooldown - dt);
  },
  onInput(e, ev) {
    if (ev.action === "fire" && e.Gun.ammo > 0 && e.Gun.cooldown === 0) {
      e.Gun.ammo -= 1;
      e.Gun.cooldown = e.Gun.interval;
      const hit = world.raycast(e.Transform.position, [0, 0, 1], 100);
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
      ["target", "hit", { damage: 1 }, { realm: "default", systemId: "shoot" }],
    ]);

    es = sandbox.run("shoot", "onUpdate", es, [0.2]);
    expect(es[0]?.states.Gun?.cooldown).toBeCloseTo(0.3);
  });

  it("ページのグローバルには触れられない", async () => {
    sandbox = await ScriptSandbox.create();
    sandbox.loadSystem(
      "peek",
      `export default system({ query: { with: [] }, onUpdate(e) {
        e.out = { fetch: typeof fetch, process: typeof process, window: typeof window, require: typeof require };
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
    sandbox = await ScriptSandbox.create({ timeLimitMs: 30 });
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
      `export default system({ onUpdate(e) { e.out = { hacked: ({}).hacked === true }; } });`,
      "repo-victim",
    );
    const [v] = sandbox.run("victim", "onUpdate", [{ id: "x", states: { out: {} } }]);
    expect(v?.states.out).toEqual({ hacked: false });
    // 同じ領域なら書き換えが見える（同じ作者の System はグローバルを共有する）
    expect(() =>
      sandbox?.loadSystem("same", "export default system({});", "repo-evil"),
    ).toThrowError(/hijacked/);
  });

  it("System を別の領域へ読み込み直すと、元の領域からは消える", async () => {
    sandbox = await ScriptSandbox.create();
    sandbox.loadSystem("s", `export default system({ onUpdate(e) { e.out = { v: 1 }; } });`, "a");
    sandbox.loadSystem("s", `export default system({ onUpdate(e) { e.out = { v: 2 }; } });`, "b");
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
