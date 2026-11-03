import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromFiles, gunAndTargetSample, toFiles } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { GitStore } from "./gitStore";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("GitStore", () => {
  it("コミット・履歴・読み出し・フォーク", async () => {
    dir = await mkdtemp(join(tmpdir(), "tk-git-"));
    const g = new GitStore(dir);
    await g.init("r1");
    expect(await g.head("r1")).toBeNull();
    expect(await g.log("r1")).toEqual([]);

    const snap = gunAndTargetSample();
    const c1 = await g.commit("r1", toFiles(snap), "最初のコミット", {
      id: "u1",
      name: "れにうむ",
    });
    snap.name = "改名";
    const c2 = await g.commit("r1", toFiles(snap), "名前を変更", { id: "u1", name: "れにうむ" }, [
      { id: "u2", name: "ここあ" },
    ]);

    const log = await g.log("r1");
    expect(log.map((c) => c.oid)).toEqual([c2, c1]);
    expect(log[0]?.message).toContain("Co-authored-by: ここあ");
    expect(log[0]?.parents).toEqual([c1]);
    expect(fromFiles(await g.files("r1")).name).toBe("改名");
    expect(fromFiles(await g.files("r1", c1)).name).toBe("銃と的");
    expect(Object.keys(await g.files("r1")).sort()).toEqual(Object.keys(toFiles(snap)).sort());

    await g.fork("r1", "r2");
    expect(await g.head("r2")).toBe(c2);
    await expect(g.init("../bad")).rejects.toThrow();
  });
});
