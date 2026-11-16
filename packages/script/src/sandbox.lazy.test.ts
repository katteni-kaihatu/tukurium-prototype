import { expect, it, vi } from "vitest";
import { ScriptSandbox } from "./sandbox";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("./debugModule", () => {
  loaded();
  return { createDebugModule: vi.fn() };
});
it("通常再生では非同期版のモジュールを読み込まない", async () => {
  const sandbox = await ScriptSandbox.create();
  try {
    sandbox.loadSystem("s", "export default system({ onUpdate() {} });");
    sandbox.run("s", "onUpdate", [{ id: "e", states: {} }]);
    expect(loaded).not.toHaveBeenCalled();
  } finally {
    sandbox.dispose();
  }
});
