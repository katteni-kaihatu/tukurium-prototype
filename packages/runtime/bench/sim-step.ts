// 実行（EKS + Rapier + QuickJS）の 1 ステップの重さを、Entity の数を変えて測る。
//   pnpm tsx scripts/bench/sim-step.ts
// 的（Collider・Target）を N 個並べ、半分は落ちる物体（RigidBody）にし、
// 全部の的を毎ステップ触る System（onUpdate）を足す。
import { gunAndTargetSample, ProjectDoc } from "@tukurium/repo-model";
import { Simulation } from "@tukurium/runtime";

const SPIN = `export default system({
  query: { with: ["Target"] },
  onUpdate(e, dt) { e.Target.hp = e.Target.hp; },
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
    doc.updateOutput({ ...out, systems: [...out.systems, sysId] });
  }
  const sim = await Simulation.create(doc.snapshot(), output, { onLog: () => {} });
  for (let i = 0; i < 30; i++) sim.step(1 / 60); // 準備運動
  const steps = 300;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) sim.step(1 / 60);
  const ms = (performance.now() - t0) / steps;
  const snapBytes = JSON.stringify(sim.world.snapshot()).length;
  sim.dispose();
  return { entities: n, script, stepMs: ms.toFixed(2), frameKB: (snapBytes / 1024).toFixed(1) };
}

for (const n of [0, 50, 100, 200, 500]) {
  console.log(await measure(n, false));
  console.log(await measure(n, true));
}
