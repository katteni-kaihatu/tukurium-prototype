import { ScriptSandbox } from "@tukurium/script";
import { createDebugModule } from "../../script/src/debugModule";

// 同じ処理の VM 呼び出しを比べる。実際の停止待ち時間は含めない。
const count = 200;
const source =
  "export default system({onUpdate(e) { let n=0; for(let i=0;i<50;i++) n+=i; globalThis.answer=n; }});";
const sync = await ScriptSandbox.create({ timeLimitMs: 1000 });
sync.loadSystem("bench", source);
const measure = async (run: () => unknown) => {
  for (let i = 0; i < 20; i++) await run();
  const start = performance.now();
  for (let i = 0; i < count; i++) await run();
  return (performance.now() - start) / count;
};
const syncMs = await measure(() => sync.run("bench", "onUpdate", [{ id: "e", states: {} }]));
sync.dispose();
const module = await createDebugModule();
const vm = module.newContext();
let hooks = 0;
const hook = vm.newAsyncifiedFunction("point", async () => {
  hooks++;
});
vm.setProp(vm.global, "point", hook);
hook.dispose();
try {
  const asyncMs = await measure(async () => {
    const result = await vm.evalCodeAsync(
      "(()=>{let n=0;for(let i=0;i<50;i++){point();n+=i;}return n;})()",
      "bench.js",
    );
    result.unwrap().dispose();
  });
  console.log({
    iterations: count,
    syncMs,
    asyncWith50HooksMs: asyncMs,
    hooks,
    note: "停止待ちを除く。同期側は Entity の受け渡しを含むため参考値",
  });
} finally {
  vm.dispose();
}
