import type { Vec3 } from "@tukurium/eks";
import { gunAndTargetSample } from "@tukurium/repo-model";
import { expect, it } from "vitest";
import { type LogEntry, Simulation } from "./simulation";
import { inputWithTools } from "./testInput";

const fire = () => ({
  action: "fire",
  phase: "down" as const,
  origin: [0, 1.5, 0] as Vec3,
  direction: [0, 0, -1] as Vec3,
  player: "p1",
});

// stepDebug() は step() の順番を写した別のコード。片方だけ直すと、デバッグ実行だけ動きが変わる。
it("停止条件のないデバッグ実行は、ふつうの再生と同じ結果になる", async () => {
  const run = async (debug: boolean) => {
    const logs: LogEntry[] = [];
    const sim = await Simulation.create(gunAndTargetSample(), "out_range", {
      realm: "repo1",
      onLog: (l) => logs.push(l),
      ...(debug
        ? {
            debug: {
              settings: () => ({
                enabled: true,
                breakOnError: true,
                breakpoints: [],
                watches: [],
              }),
              onPause: () => {
                throw new Error("止まらないはず");
              },
            },
          }
        : {}),
    });
    try {
      // 撃つ（入力）→ 当たる（イベント）→ 倒れて復活する（更新）まで。
      for (let frame = 0; frame < 200; frame++) {
        if (frame % 16 === 0 && frame < 64) inputWithTools(sim, fire());
        if (debug) await sim.stepDebug(1 / 60);
        else sim.step(1 / 60);
      }
      return {
        world: sim.world.snapshot(),
        ammo: sim.world.get("ent_gun", "ks_gun")?.f_ammo,
        time: sim.time,
        status: sim.systemStatus(),
        logs: logs.map((l) => [l.level, l.systemId, l.message]),
      };
    } finally {
      sim.dispose();
    }
  };
  const plain = await run(false);
  const debug = await run(true);
  // 撃てていなければ、見比べる意味がない。
  expect(plain.ammo).toBeLessThan(12);
  expect(debug.status).toEqual(plain.status);
  expect(debug.logs).toEqual(plain.logs);
  expect(debug.time).toBe(plain.time);
  expect(debug.world).toEqual(plain.world);
});
