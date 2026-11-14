import { VALUE_CODEC_SOURCE } from "@tukurium/eks";
import { instrumentDebug } from "@tukurium/repo-model";
import { DEBUG_PRELUDE, type DebugPoint } from "@tukurium/script";
import { expect, it } from "vitest";
import { createDebugModule } from "../../script/src/debugModule";

it("D0: 書き換えた内側の呼び出しで待ち、外側の変数を変更して同じフレームを続ける", async () => {
  const module = await createDebugModule();
  const vm = module.newContext();
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const events: string[] = [];
  const pause = vm.newAsyncifiedFunction("__debugPause", async (handle) => {
    const point = JSON.parse(vm.getString(handle)) as DebugPoint;
    if (point.frames.length !== 2 || point.line !== 4) return vm.newString("[]");
    expect(point.frames[0]?.variables.find((v) => v.name === "outer")?.value).toBe(3);
    expect(point.frames[1]?.variables.find((v) => v.name === "inner")?.value).toBe(2);
    events.push("pause");
    reached();
    return new Promise<void>((resolve) => {
      resume = resolve;
    }).then(() =>
      vm.newString(
        JSON.stringify([
          { frameId: point.frames[0]?.id, name: "outer", value: 10 },
          { frameId: point.frames[1]?.id, name: "inner", value: 5 },
        ]),
      ),
    );
  });
  vm.setProp(vm.global, "__debugPause", pause);
  pause.dispose();
  const init = vm.evalCode(
    `const __codec=(${VALUE_CODEC_SOURCE})();let __current='s',__entity='e';${DEBUG_PRELUDE}__debugActive=true;`,
  );
  init.unwrap().dispose();
  const source = instrumentDebug(`function outerFn() { let outer=3;
function innerFn() {
let inner=2;
return inner + outer;
}
return innerFn(); }
outerFn();`).javascript;
  try {
    const frame = (async () => {
      events.push("physics");
      const result = await vm.evalCodeAsync(source);
      const value = vm.getNumber(result.unwrap());
      result.dispose();
      events.push("next system");
      return value;
    })();
    await paused;
    expect(events).toEqual(["physics", "pause"]);
    resume();
    expect(await frame).toBe(15);
    expect(events).toEqual(["physics", "pause", "next system"]);
  } finally {
    vm.dispose();
  }
});
