import { gunAndTargetSample } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";

/**
 * 書き込みがすぐ届く（ADR 0082）：e.get() で書いた値は、Entity の値を読み書きする Host API を呼ぶ直前に World へ届き、
 * Host API が書いた値は、スクリプトが持っている値へ返る。
 */
let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

/**
 * 銃と的のサンプル（的は hp が 3）に、的を回す System を一つだけ動かす。
 * スクリプトの中では、回った的の ID が順に seen に入る（seen[0] が初めに回った的）。nth は、いま何番目か（1 始まり）。
 */
async function run(body: string): Promise<{
  logs: string[];
  count: number;
  hp: (which: number) => unknown;
  last: () => unknown;
}> {
  const snap = gunAndTargetSample();
  const targets = snap.entities.filter((e) => e.states.ks_target).map((e) => e.id);
  // 回る順番は World の Query の順。「あとで回る的」を決めるために、先に同じ World を作って順番を見る
  const probe = await Simulation.create(gunAndTargetSample(), "out_range", { realm: "repo1" });
  const order = probe.world.query({ with: ["ks_target"] });
  probe.dispose();
  const lastId = order[order.length - 1] ?? "";
  snap.systems.push({
    id: "sys_t",
    name: "T",
    code: [
      'import Target from "./Target.koko";',
      "const seen = [];",
      "export default system({",
      "  query: { with: [Target] },",
      `  onUpdate(e) {\nconst nth = seen.push(e.id);\n${body.replaceAll("__LAST__", lastId)}\n  },`,
      "});",
    ].join("\n"),
  });
  const out = snap.outputs.find((o) => o.id === "out_range");
  if (!out) throw new Error("out_range がありません");
  out.systems = [{ id: "sys_t", enabled: true }];
  const logs: LogEntry[] = [];
  sim = await Simulation.create(snap, "out_range", { realm: "repo1", onLog: (l) => logs.push(l) });
  sim.step(1 / 60);
  expect(sim.systemStatus().map((s) => s.error ?? null)).toEqual([null]);
  const world = sim.world;
  return {
    logs: logs.filter((l) => l.level === "log").map((l) => l.message),
    count: targets.length,
    last: () => world.get(lastId, "ks_target")?.f_hp,
    hp: (which) => world.get(targets[which] ?? "", "ks_target")?.f_hp,
  };
}

describe("書き込みがすぐ届く", () => {
  it("e.get() で書いたあと、world.get で読むと書いた値になっている", async () => {
    const r = await run(
      'const t = e.get(Target); t.hp = 9; log(String(world.get(e.id, "Target").hp));',
    );
    expect(r.logs).toEqual(Array(r.count).fill("9"));
    expect(r.hp(0)).toBe(9);
  });

  it("Host API で書いた値が、スクリプトが持っている値に届き、古い値で上書きされない", async () => {
    const r = await run(
      'const t = e.get(Target); world.set(e.id, "Target", { hp: 7 }); log(String(t.hp));',
    );
    expect(r.logs).toEqual(Array(r.count).fill("7"));
    expect(r.hp(0)).toBe(7);
    expect(r.hp(1)).toBe(7);
  });

  it("Host API で書いたフィールドのほかは、スクリプトが書いた値のまま残る", async () => {
    const r = await run(
      [
        "const t = e.get(Target);",
        "t.respawnAt = 5;",
        'world.set(e.id, "Target", { hp: 7 });',
        "log(t.hp + ':' + t.respawnAt);",
      ].join("\n"),
    );
    expect(r.logs).toEqual(Array(r.count).fill("7:5"));
  });

  it("途中で届いた値を初めの値に戻すと、World も戻る", async () => {
    const r = await run('const t = e.get(Target); t.hp = 9; world.get(e.id, "Target"); t.hp = 3;');
    expect(r.hp(0)).toBe(3);
    expect(r.hp(1)).toBe(3);
  });

  it("Host API で書いた値が、同じ呼び出しのあとの Entity に届く", async () => {
    const r = await run(
      [
        "const t = e.get(Target);",
        `if (nth === 1) world.set(${JSON.stringify("__LAST__")}, "Target", { hp: 42 });`,
        `else if (e.id === ${JSON.stringify("__LAST__")}) log(String(t.hp));`,
      ].join("\n"),
    );
    expect(r.logs).toEqual(["42"]);
    expect(r.last()).toBe(42);
  });

  it("前の Entity が、最後の Host API のあとに書いた値も、次の Entity の Host API から見える", async () => {
    const r = await run(
      [
        "const t = e.get(Target);",
        'if (nth === 1) { world.get(e.id, "Target"); t.hp = 8; }',
        'else if (nth === 2) log(String(world.get(seen[0], "Target").hp));',
      ].join("\n"),
    );
    expect(r.logs).toEqual(["8"]);
  });

  it("Entity の値を見ない Host API（時刻など）を呼んでも、値はそのまま届く", async () => {
    const r = await run("const t = e.get(Target); t.hp = 4; time.now(); t.hp = 6;");
    expect(r.hp(0)).toBe(6);
  });

  it("型の合わない値は、途中で合わせても World に入らない", async () => {
    const r = await run(
      'const t = e.get(Target); t.hp = "たくさん"; log(String(world.get(e.id, "Target").hp));',
    );
    expect(r.logs).toEqual(Array(r.count).fill("3"));
    expect(r.hp(0)).toBe(3);
  });
});
