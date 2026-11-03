import { HOST_CAPABILITIES } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { HOST_API_POLICY } from "./capabilities";
import { HOST_API_ARGS } from "./hostApi";
import { HOST_API_SPEC, hostApiCompletions, hostApiDeclarations } from "./hostApiSpec";
import { HOST_API } from "./simulation";

describe("Host API の一つの定義（HOST_API_SPEC）", () => {
  it("すべての Host API を持ち、検証・権限の分類・コードの読み取りの表はここから作る", () => {
    expect(Object.keys(HOST_API_SPEC).sort()).toEqual([...HOST_API].sort());
    for (const name of HOST_API) {
      expect(HOST_API_ARGS[name]).toBe(HOST_API_SPEC[name].args);
      expect(HOST_API_POLICY[name].capability).toBe(HOST_API_SPEC[name].capability);
      expect(HOST_CAPABILITIES[name]).toBe(HOST_API_SPEC[name].capability);
    }
  });

  it("利用者向けの型の宣言を作る（名前空間ごと。Raycast の結果の型も）", () => {
    const d = hostApiDeclarations();
    expect(d).toContain("declare const world: {");
    expect(d).toContain("raycast(origin: Vec3, direction: Vec3, max?: number): Hit | null;");
    expect(d).toContain("interface Hit {");
    expect(d).toContain(
      'send(contract: "Damage", payload: { amount: number; type?: string }): boolean;',
    );
    expect(d).toContain("declare const audio: {");
    for (const name of HOST_API) expect(d).toContain(`${name.split(".")[1]}(`);
  });

  it("エディタの入力補完の候補を、名前空間ごとに作る（説明と要る権限つき）", () => {
    const world = hostApiCompletions("world");
    expect(world.map((c) => c.label)).toContain("raycast");
    expect(world.find((c) => c.label === "raycast")).toMatchObject({
      detail: "(origin: Vec3, direction: Vec3, max?: number): Hit | null",
      info: expect.stringContaining("physics.raycast"),
    });
    expect(hostApiCompletions("nope")).toEqual([]);
  });
});
