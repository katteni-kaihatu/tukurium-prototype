import { describe, expect, it } from "vitest";
import { parseRecent, pushRecent, RECENT_LIMIT } from "./recentProjects";

describe("最近開いたプロジェクト", () => {
  it("新しいものを先頭に足し、同じものは前の記録を消す", () => {
    const list = pushRecent(pushRecent(pushRecent([], "a", 1), "b", 2), "a", 3);
    expect(list).toEqual([
      { repoId: "a", openedAt: 3 },
      { repoId: "b", openedAt: 2 },
    ]);
  });

  it(`${RECENT_LIMIT} 件までにする`, () => {
    let list = pushRecent([], "r0", 0);
    for (let i = 1; i < 8; i++) list = pushRecent(list, `r${i}`, i);
    expect(list.map((entry) => entry.repoId)).toEqual(["r7", "r6", "r5", "r4", "r3"]);
  });

  it("壊れた保存は捨てる", () => {
    expect(parseRecent("{")).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent('[{"repoId":"a","openedAt":1},{"repoId":2}]')).toEqual([
      { repoId: "a", openedAt: 1 },
    ]);
  });
});
