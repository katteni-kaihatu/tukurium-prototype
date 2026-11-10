import { describe, expect, it } from "vitest";
import { waitUntilIdle } from "./waitUntilIdle";

describe("読み込み待ち", () => {
  it("制限時間を超えても残っていれば、終わっていない", async () => {
    expect(await waitUntilIdle(() => 1, 30)).toBe(false);
  });

  it("途中で 0 になれば、終わったことにする", async () => {
    let left = 1;
    setTimeout(() => {
      left = 0;
    }, 15);
    expect(await waitUntilIdle(() => left, 200)).toBe(true);
  });
});
