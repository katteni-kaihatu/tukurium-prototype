import { gunAndTargetSample } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";

/**
 * System に Entity を渡す前の確かめ（ADR 0082）：呼び出しの途中で消えた Entity は、そのあとの順番で渡さない。
 * onUpdate の途中で作り、Query に合う Entity は、同じ呼び出しの並びの後ろに足す。
 */
let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

/**
 * 銃と的のサンプルに、的（Target）を回す System を一つだけ動かす。スクリプトの中では、回った Entity の ID が
 * 順に seen に入り、nth は、いま何番目か（1 始まり）。steps 回だけ進める。
 */
async function run(body: string, steps = 1) {
  const snap = gunAndTargetSample();
  const ids = snap.entities.filter((e) => e.states.ks_target).map((e) => e.id);
  const targets = ids.length;
  snap.systems.push({
    id: "sys_t",
    name: "T",
    code: [
      'import Target from "./Target.koko";',
      "let seen = [];",
      "export default system({",
      "  query: { with: [Target] },",
      `  onUpdate(e) {\nconst nth = seen.push(e.id);\n${body.replaceAll("__ALL__", JSON.stringify(ids))}\n  },`,
      "});",
    ].join("\n"),
  });
  const out = snap.outputs.find((o) => o.id === "out_range");
  if (!out) throw new Error("out_range がありません");
  out.systems = [{ id: "sys_t", enabled: true }];
  const logs: LogEntry[] = [];
  // 一度にたくさん作る場合も確かめるので、時間制限は長くしておく
  sim = await Simulation.create(snap, "out_range", {
    realm: "repo1",
    onLog: (l) => logs.push(l),
    timeLimitMs: 2000,
  });
  for (let i = 0; i < steps; i++) sim.step(1 / 60);
  const status = sim.systemStatus()[0];
  expect(status?.error ?? null).toBe(null);
  return {
    logs: logs.filter((l) => l.level === "log").map((l) => l.message),
    targets,
    count: sim.world.query({ with: ["ks_target"] }).length,
    warnings: (status?.warnings ?? []).map((w) => w.code),
  };
}

describe("渡す前の確かめ：消えた Entity", () => {
  it("消した Entity は、同じ呼び出しのあとの順番で渡されない", async () => {
    const r = await run(
      [
        "if (nth === 1) for (const id of world.get(e.id, 'Target') ? others() : []) world.destroy(id);",
        "log('回った');",
        "function others() { return __ALL__.filter((id) => id !== e.id); }",
      ].join("\n"),
    );
    expect(r.logs).toEqual(["回った"]);
    expect(r.count).toBe(1);
  });

  it("親を消すと、同じ呼び出しの並びにある子も渡されない", async () => {
    const r = await run(
      [
        "if (nth === 1) {",
        "  const parent = world.spawn({ name: '親', states: { Target: { hp: 1 } } });",
        "  world.spawn({ name: '子', parent, states: { Target: { hp: 1 } } });",
        "  world.destroy(parent);",
        "}",
        "log('回った');",
      ].join("\n"),
    );
    expect(r.logs).toHaveLength(r.targets);
    expect(r.count).toBe(r.targets);
  });

  it("消えた Entity の値を読み書きしても止まらず、読むと undefined になり、問題として出る", async () => {
    const r = await run(
      [
        "if (nth !== 1) return;",
        "const t = e.get(Target);",
        "world.destroy(e.id);",
        "t.hp = 9;",
        "log(String(t.hp) + ':' + String(e.get(Target).hp));",
      ].join("\n"),
    );
    expect(r.logs).toEqual(["undefined:undefined"]);
    expect(r.warnings).toEqual(["entity-gone"]);
    expect(r.count).toBe(r.targets - 1);
  });

  it("消えた Entity の値に触れなければ、問題は出ない", async () => {
    const r = await run("if (nth === 1) { e.get(Target).hp = 5; world.destroy(e.id); }");
    expect(r.warnings).toEqual([]);
    expect(r.count).toBe(r.targets - 1);
  });
});

describe("渡す前の確かめ：作った Entity", () => {
  it("onUpdate で作り、Query に合う Entity は、同じ呼び出しの中で処理される", async () => {
    const r = await run(
      [
        "if (nth === 1) world.spawn({ name: '弾', states: { Target: { hp: 77 } } });",
        "log(String(e.get(Target).hp));",
      ].join("\n"),
    );
    expect(r.logs).toHaveLength(r.targets + 1);
    expect(r.logs.at(-1)).toBe("77");
  });

  it("足した Entity に書いた値も、World に届く", async () => {
    const r = await run(
      [
        "if (nth === 1) world.spawn({ name: '弾', states: { Target: { hp: 77 } } });",
        "const t = e.get(Target);",
        "if (t.hp === 77) t.hp = 78;",
      ].join("\n"),
    );
    expect(r.count).toBe(r.targets + 1);
    const world = sim?.world;
    const hps = world?.query({ with: ["ks_target"] }).map((id) => world.get(id, "ks_target")?.f_hp);
    expect(hps).toContain(78);
    expect(hps).not.toContain(77);
  });

  it("Query に合わない Entity は足されない", async () => {
    const r = await run("if (nth === 1) world.spawn({ name: '空' }); log('回った');");
    expect(r.logs).toHaveLength(r.targets);
  });

  it("一つの呼び出しで足せるのは 256 個まで。超えた分は、次の呼び出しから処理される", async () => {
    const body = [
      "if (nth === 1) for (let i = 0; i < 300; i++) world.spawn({ name: '弾', states: { Target: { hp: 1 } } });",
      "log('回った');",
    ].join("\n");
    const first = await run(body);
    expect(first.logs).toHaveLength(first.targets + 256);
    expect(first.warnings).toEqual(["run-add-limit"]);
    sim?.dispose();
    const second = await run(body, 2);
    expect(second.logs).toHaveLength(second.targets + 256 + second.targets + 300);
  });
});
