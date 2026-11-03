import { describe, expect, it } from "vitest";
import { inferCapabilities } from "./systemCapabilities";

describe("inferCapabilities（コードから要る Capability を読み取る。ADR 0012）", () => {
  it("使っている Host API と、Raycast の結果の send / effect から読み取る", () => {
    const r = inferCapabilities(
      "sys",
      `export default system({
  onInput(e, ev) {
    const hit = world.raycast(ev.origin, ev.direction, 100);
    if (!hit) return;
    hit.effect("spark");
    hit.send("Damage", { amount: 1 });
    audio.play("bang");
    log(time.now());
  },
});`,
    );
    expect(r.capabilities).toEqual([
      "audio.play",
      "effects.spawn",
      "interaction.send",
      "physics.raycast",
      "time.read",
    ]);
    expect(r.diagnostics).toEqual([]);
  });

  it("world.* の操作をそれぞれの Capability にする", () => {
    const r = inferCapabilities(
      "sys",
      "world.get(a, B); world.set(a, B, {}); world.find('x'); world.spawn({}); world.destroy(a); world.emit(a, 'n');",
    );
    expect(r.capabilities).toEqual([
      "entity.destroy",
      "entity.discover",
      "entity.spawn",
      "interaction.send",
      "state.read",
      "state.write",
    ]);
  });

  it("動的な呼び方は読み取れないので、その行の問題にする", () => {
    const r = inferCapabilities("sys", "const n = 'raycast';\nworld[n](a, b);\nconst w = world;");
    expect(r.diagnostics.map((d) => [d.code, d.severity, d.location])).toEqual([
      ["dynamic-host-access", "warning", { kind: "script", line: 2, symbol: "world" }],
      ["dynamic-host-access", "warning", { kind: "script", line: 3, symbol: "world" }],
    ]);
  });

  it("Capability の要らないコード・構文の誤り", () => {
    expect(
      inferCapabilities("sys", "export default system({ onUpdate(e) { e.x = 1; } });").capabilities,
    ).toEqual([]);
    expect(inferCapabilities("sys", "let = ;")).toEqual({ capabilities: [], diagnostics: [] });
  });
});
