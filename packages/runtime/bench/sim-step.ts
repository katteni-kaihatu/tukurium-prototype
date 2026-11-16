// 実行（EKS + Rapier + QuickJS）の 1 ステップの重さを、Entity の数を変えて測る。
//   pnpm bench:sim
// 的（Collider・Target）を N 個並べ、半分は落ちる物体（RigidBody）にし、
// 全部の的を毎ステップ触る System（onUpdate）を足す。
import { stringifyValue } from "@tukurium/eks";
import { gunAndTargetSample, ProjectDoc } from "@tukurium/repo-model";
import { Simulation } from "@tukurium/runtime";

const SPIN = `import Target from "./Target.koko";
export default system({
  query: { with: [Target] },
  onUpdate(e, dt) { const t = e.get(Target); t.hp = t.hp; },
});
`;

async function measure(n: number, script: boolean) {
  const doc = new ProjectDoc();
  doc.load(gunAndTargetSample());
  const snap0 = doc.snapshot();
  const output = snap0.outputs[0].id;
  const target = snap0.entities.find((e) => e.name === "的1");
  if (!target) throw new Error("的1 がありません");
  for (let i = 0; i < n; i++) {
    const states = structuredClone(target.states) as Record<string, Record<string, unknown>>;
    states["builtin.Transform"] = {
      ...states["builtin.Transform"],
      position: [(i % 20) * 1.5 - 15, 1 + Math.floor(i / 20) * 1.5, -10],
    };
    if (i % 2 === 0) states["builtin.RigidBody"] = { type: "dynamic" };
    doc.addEntity({ output, name: `的x${i}`, states });
  }
  if (script) {
    const sysId = doc.addSystem("Spin", SPIN);
    const out = doc.outputs()[0];
    doc.updateOutput({ ...out, systems: [...out.systems, { id: sysId, enabled: true }] });
  }
  const sim = await Simulation.create(doc.snapshot(), output, { onLog: () => {} });
  const stopped = sim.systemStatus().filter((s) => s.error);
  if (stopped.length > 0) throw new Error(`System が止まっています: ${stopped[0]?.error}`);
  for (let i = 0; i < 30; i++) sim.step(1 / 60); // 準備運動
  const steps = 300;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) sim.step(1 / 60);
  const ms = (performance.now() - t0) / steps;
  const snapBytes = stringifyValue(sim.world.snapshot()).length;
  sim.dispose();
  return { entities: n, script, stepMs: ms.toFixed(2), frameKB: (snapBytes / 1024).toFixed(1) };
}

for (const n of process.env.BENCH_SYSTEM_ONLY ? [] : [0, 50, 100, 200, 500]) {
  console.log(await measure(n, false));
  console.log(await measure(n, true));
}

// System の呼び出しだけの重さ（ADR 0082）。物理を持たない Entity を 1000 個回し、Host API を呼ばない System と、
// Entity ごとに Host API を呼ぶ System を比べる。書き込みを Host API の境目で合わせる分の重さを見る。
const NO_HOST = `import Target from "./Target.koko";
export default system({
  query: { with: [Target] },
  onUpdate(e, dt) { const t = e.get(Target); t.hp = t.hp + 1; },
});
`;
const HOST_READ = `import Target from "./Target.koko";
export default system({
  query: { with: [Target] },
  onUpdate(e, dt) { const t = e.get(Target); t.hp = t.hp + 1; time.now(); },
});
`;
const HOST_READ_BACK = `import Target from "./Target.koko";
export default system({
  query: { with: [Target] },
  onUpdate(e, dt) { const t = e.get(Target); t.hp = t.hp + 1; world.get(e.id, "Target"); },
});
`;
const HOST_WRITE = `import Target from "./Target.koko";
export default system({
  query: { with: [Target] },
  onUpdate(e, dt) { const t = e.get(Target); world.set(e.id, "Target", { hp: t.hp + 1 }); },
});
`;

async function measureSystem(name: string, code: string, n: number) {
  const doc = new ProjectDoc();
  doc.load(gunAndTargetSample());
  const snap0 = doc.snapshot();
  const output = snap0.outputs[0].id;
  const target = snap0.entities.find((e) => e.name === "的1");
  if (!target) throw new Error("的1 がありません");
  const targetKoko = snap0.kokostates.find((k) => k.name === "Target");
  if (!targetKoko) throw new Error("Target がありません");
  for (let i = 0; i < n; i++)
    doc.addEntity({
      output,
      name: `印${i}`,
      states: { [targetKoko.id]: structuredClone(target.states[targetKoko.id] ?? {}) },
    });
  const sysId = doc.addSystem("Bench", code);
  const out = doc.outputs()[0];
  doc.updateOutput({ ...out, systems: [{ id: sysId, enabled: true }] });
  const sim = await Simulation.create(doc.snapshot(), output, {
    onLog: () => {},
    timeLimitMs: 1000,
  });
  const stopped = sim.systemStatus().filter((s) => s.error);
  if (stopped.length > 0) throw new Error(`System が止まっています: ${stopped[0]?.error}`);
  for (let i = 0; i < 20; i++) sim.step(1 / 60);
  const rounds: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    rounds.push((performance.now() - t0) / 60);
  }
  const failed = sim.systemStatus().filter((s) => s.error);
  if (failed.length > 0) throw new Error(`System が止まりました: ${failed[0]?.error}`);
  sim.dispose();
  rounds.sort((a, b) => a - b);
  return { system: name, entities: n, stepMs: rounds[2]?.toFixed(2), min: rounds[0]?.toFixed(2) };
}

for (const [name, code] of [
  ["Host API を呼ばない", NO_HOST],
  ["Entity ごとに読むだけの Host API", HOST_READ],
  ["書いてから world.get で読む", HOST_READ_BACK],
  ["Entity ごとに world.set で書く", HOST_WRITE],
] as const)
  console.log(await measureSystem(name, code, 1000));
