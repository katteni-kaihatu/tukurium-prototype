import { describe, expect, it } from "vitest";
import { createDebugModule } from "./debugModule";

describe("D0: 非同期 QuickJS", () => {
  it("外側の値を停止前に写し取り、再開の返り値で変え、フレームを待てる", async () => {
    const module = await createDebugModule();
    const vm = module.newContext();
    let resume!: (value: string) => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let snapshot: unknown;
    const hook = vm.newAsyncifiedFunction("pause", (value) => {
      snapshot = JSON.parse(vm.getString(value));
      reached();
      return new Promise<string>((resolve) => {
        resume = resolve;
      }).then((edit) => vm.newString(edit));
    });
    vm.setProp(vm.global, "pause", hook);
    hook.dispose();
    const source = [
      "let outer = 4;",
      "function nested() { let inner = 2;",
      "const edit = JSON.parse(pause(JSON.stringify({outer, inner}))); outer = edit.outer; inner = edit.inner;",
      "return outer + inner; }",
      "nested();",
    ].join("\n");
    try {
      const frame = vm.evalCodeAsync(source);
      await paused;
      expect(snapshot).toEqual({ outer: 4, inner: 2 });
      let finished = false;
      void frame.then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      resume('{"outer":7,"inner":3}');
      const result = await frame;
      expect(result.error).toBeUndefined();
      expect(vm.getNumber(result.unwrap())).toBe(10);
      result.dispose();
      expect(source.split("\n")).toHaveLength(5);
    } finally {
      vm.dispose();
    }
  });
});
