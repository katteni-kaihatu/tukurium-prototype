import { describe, expect, it } from "vitest";
import { countdownSeconds, nextCountdown } from "./worldChange";

describe("ワールドを変えるカウントダウン", () => {
  it("届いた残り時間から終わりを決め、同じ入れ替えでは動かさない", () => {
    const first = nextCountdown(null, { id: "wc_1", remainingMs: 3000 }, 1_000);
    expect(first).toEqual({ id: "wc_1", endsAt: 4_000 });
    expect(nextCountdown(first, { id: "wc_1", remainingMs: 2400 }, 1_600)).toBe(first);
  });

  it("別のワールドを選んだら、新しい残り時間から数え直す", () => {
    const first = nextCountdown(null, { id: "wc_1", remainingMs: 3000 }, 1_000);
    expect(nextCountdown(first, { id: "wc_2", remainingMs: 3000 }, 1_500)).toEqual({
      id: "wc_2",
      endsAt: 4_500,
    });
  });

  it("予定がなくなったら、表示を消す", () => {
    const first = nextCountdown(null, { id: "wc_1", remainingMs: 3000 }, 1_000);
    expect(nextCountdown(first, null, 2_000)).toBeNull();
  });

  it("3、2、1 と減り、入れ替わる瞬間までは 1 のまま", () => {
    expect(countdownSeconds(4_000, 1_000)).toBe(3);
    expect(countdownSeconds(4_000, 2_000)).toBe(2);
    expect(countdownSeconds(4_000, 3_001)).toBe(1);
    expect(countdownSeconds(4_000, 4_000)).toBe(1);
    expect(countdownSeconds(4_000, 4_200)).toBe(1);
  });
});
