import { describe, expect, it } from "vitest";
import { HOST_API_POLICY } from "./capabilities";
import { HOST_API } from "./simulation";

describe("Host API の棚卸し（ADR 0012）", () => {
  it("すべての Host API に Capability の分類がある（分類のない API を足すと落ちる）", () => {
    expect(Object.keys(HOST_API_POLICY).sort()).toEqual([...HOST_API].sort());
  });

  it("別の配置に届いてしまう API は、U1 / U2 で扱いを決めてある", () => {
    const reaching = Object.entries(HOST_API_POLICY)
      .filter(([, p]) => p.currentReach === "any-placement")
      .map(([name, p]) => [name, p.crossPlacement]);
    // 別の配置へ届くのは、opaque handle を返す Raycast と、公開 Contract を呼ぶ contract.send だけ（U2）
    expect(reaching.sort()).toEqual([
      ["contract.send", "public-contract"],
      ["world.raycast", "target-policy"],
    ]);
  });
});
