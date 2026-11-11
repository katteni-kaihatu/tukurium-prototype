import { describe, expect, it } from "vitest";
import {
  activityFromCommits,
  editingRepoIds,
  type ListedProject,
  type ListedRelease,
  latestVersions,
  listProjects,
  listReleases,
  savedLabel,
  sparkCounts,
} from "./projectHome";

const now = new Date(2026, 10, 12, 15, 0, 0).getTime();

function project(
  patch: Partial<ListedProject> & Pick<ListedProject, "id" | "name">,
): ListedProject {
  return {
    description: "",
    kind: "item",
    visibility: "public",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: 0,
    forkedFrom: null,
    ...patch,
  };
}

describe("プロジェクト一覧", () => {
  const repos = [
    project({ id: "a", name: "銃と的", description: "撃って当てる", kind: "item", updatedAt: 30 }),
    project({
      id: "b",
      name: "射撃場",
      kind: "world",
      visibility: "private",
      updatedAt: 20,
    }),
    project({ id: "c", name: "マルバツ", kind: "item", updatedAt: 10 }),
  ];

  it("名前と説明で絞り、種類と公開範囲を重ねる", () => {
    expect(
      listProjects(repos, { query: "当てる", kind: "all", visibility: "all", sort: "updated" }).map(
        (r) => r.id,
      ),
    ).toEqual(["a"]);
    expect(
      listProjects(repos, { query: "", kind: "world", visibility: "all", sort: "updated" }).map(
        (r) => r.id,
      ),
    ).toEqual(["b"]);
    expect(
      listProjects(repos, { query: "", kind: "item", visibility: "private", sort: "name" }),
    ).toEqual([]);
  });

  it("更新・名前・作成で並べる", () => {
    expect(
      listProjects(repos, { query: "", kind: "all", visibility: "all", sort: "updated" }).map(
        (r) => r.id,
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      listProjects(repos, { query: "", kind: "all", visibility: "all", sort: "name" }).map(
        (r) => r.name,
      )[0],
    ).toBe("マルバツ");
    const created = [
      project({ id: "new", name: "新しい", createdAt: "2026-11-10T00:00:00.000Z" }),
      project({ id: "old", name: "古い", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(
      listProjects(created, { query: "", kind: "all", visibility: "all", sort: "created" }).map(
        (r) => r.id,
      ),
    ).toEqual(["new", "old"]);
  });

  it("保存の時刻を、近いほうから言い換える", () => {
    expect(savedLabel(now - 10_000, now)).toBe("たった今保存");
    expect(savedLabel(now - 5 * 60_000, now)).toBe("5分前に保存");
    expect(savedLabel(now - 2 * 60 * 60_000, now)).toBe("2時間前に保存");
    expect(savedLabel(new Date(2026, 10, 11, 10).getTime(), now)).toBe("昨日に保存");
    expect(savedLabel(new Date(2026, 10, 9, 12).getTime(), now)).toBe("3日前に保存");
    expect(savedLabel(new Date(2026, 10, 4, 12).getTime(), now)).toBe("先週に保存");
    expect(savedLabel(new Date(2026, 9, 1, 12).getTime(), now)).toBe("10月1日に保存");
  });

  it("週ごとの回数は、右端がいまの週になる", () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    const counts = sparkCounts([now - 1, now - week - 1, now - 12 * week], now, 4);
    expect(counts).toEqual([0, 0, 1, 1]);
    const activity = activityFromCommits([], "2026-11-12T00:00:00.000Z", now);
    expect(activity.counts.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(activity.savedAt).toBe(Date.parse("2026-11-12T00:00:00.000Z"));
  });

  it("参加しているワークスペースのプロジェクトだけを編集中にする", () => {
    const ids = editingRepoIds(
      [
        { id: "w1", repoId: "a", present: ["me"] },
        { id: "w2", repoId: "b", present: [] },
        { id: "w3", repoId: null, present: ["me"] },
      ],
      "me",
      "w2",
    );
    expect([...ids].sort()).toEqual(["a", "b"]);
  });
});

describe("リリース一覧", () => {
  const releases: ListedRelease[] = [
    { id: "r1", name: "銃と的", repoId: "a", repoName: "銃と的", kind: "item", version: 3, at: 30 },
    { id: "r2", name: "鍵と扉", repoId: "c", repoName: "鍵と扉", kind: "item", version: 2, at: 10 },
    { id: "r3", name: "森", repoId: "b", repoName: "森", kind: "world", version: 1, at: 20 },
  ];

  it("プロジェクトごとに、いちばん新しい版だけを残す", () => {
    expect(latestVersions(releases)).toEqual(
      new Map([
        ["a", 3],
        ["c", 2],
        ["b", 1],
      ]),
    );
  });

  it("種類と名前で絞り、新しい順に並べる", () => {
    expect(
      listReleases(releases, { query: "扉", kind: "all", sort: "updated" }).map((r) => r.id),
    ).toEqual(["r2"]);
    expect(
      listReleases(releases, { query: "", kind: "item", sort: "updated" }).map((r) => r.id),
    ).toEqual(["r1", "r2"]);
    expect(
      listReleases(releases, { query: "", kind: "all", sort: "name" }).map((r) => r.name)[0],
    ).toBe("鍵と扉");
  });
});
