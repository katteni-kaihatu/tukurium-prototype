import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedItem } from "../net/api";
import { newerRelease, shelfItems, useItemShelf } from "./itemShelf";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  useItemShelf.setState(useItemShelf.getInitialState(), true);
});

describe("所持品の整理情報", () => {
  it("アカウントを切り替えても、別の人のお気に入りを混ぜない", () => {
    useItemShelf.getState().load("alice");
    useItemShelf.getState().toggleFavorite("table");
    useItemShelf.getState().load("bob");
    expect(useItemShelf.getState().labels).toEqual({});
    useItemShelf.getState().load("alice");
    expect(useItemShelf.getState().labels.table).toEqual({ favorite: true });
  });

  it("以前の自分用タグを公開タグとして読み込まない", () => {
    storage.set(
      "tukurium.item-shelf.v1:alice",
      JSON.stringify({ labels: { table: { favorite: true, tags: ["自分専用"] } } }),
    );
    useItemShelf.getState().load("alice");
    expect(useItemShelf.getState().labels.table).toEqual({ favorite: true });
  });

  it("保存が拒まれても、画面の操作を続けられ、未保存だと分かる", () => {
    useItemShelf.getState().load("alice");
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("quota");
      },
    });
    useItemShelf.getState().toggleFavorite("table");
    expect(useItemShelf.getState().labels.table?.favorite).toBe(true);
    expect(useItemShelf.getState().storageError).toBe(true);
  });
});

const item = (workId: string, name: string, available = true) =>
  ({
    workId,
    available,
    acquiredAt: "2026-11-05T00:00:00Z",
    work: { name, ownerName: "作者", tags: workId === "c" ? ["ゲーム"] : ["ゲーム", "みんなで"] },
  }) as OwnedItem;

describe("所持品の絞り込み", () => {
  it("検索・複数タグ・お気に入り・利用可否を同時に満たすものだけを返す", () => {
    const items = [item("a", "Table 2"), item("b", "Table 10", false), item("c", "Table 3")];
    const labels = {
      a: { favorite: true },
      b: { favorite: true },
      c: { favorite: true },
    };
    const result = shelfItems(items, labels, {
      query: "ＴＡＢＬＥ ゲーム",
      filter: "favorites",
      tags: ["ゲーム", "みんなで"],
      availableOnly: true,
      sort: "name",
    });
    expect(result.map((entry) => entry.workId)).toEqual(["a"]);
    expect(items).toHaveLength(3);
  });

  it("数字を含む名前で並べ替えても、元の所持一覧の順序を変えない", () => {
    const items = [item("b", "Table 10"), item("a", "Table 2")];
    const result = shelfItems(
      items,
      {},
      { query: "", filter: "all", tags: [], availableOnly: false, sort: "name" },
    );
    expect(result.map((entry) => entry.workId)).toEqual(["a", "b"]);
    expect(items.map((entry) => entry.workId)).toEqual(["b", "a"]);
  });
});

describe("新しい版", () => {
  const owned = (version: number, latest: number | null, available = true) =>
    ({
      workId: "w",
      releaseId: `r${version}`,
      available,
      release: { id: `r${version}`, version },
      work: { latest: latest === null ? null : { id: `r${latest}`, version: latest } },
    }) as OwnedItem;

  it("所持している版より新しい版があるときだけ返す", () => {
    expect(newerRelease(owned(1, 3))?.id).toBe("r3");
    expect(newerRelease(owned(3, 3))).toBeNull();
    // マーケットに登録されていれば、公開中の版まで
    const listed = { ...owned(1, 3), userId: "buyer" };
    if (listed.work?.latest) listed.work.owner = "author";
    if (listed.work?.latest)
      listed.work.market = {
        price: 0,
        autoPublish: false,
        release: { ...listed.work.latest, id: "r2", version: 2 },
        listedAt: "",
        acquisitions: 0,
      };
    expect(newerRelease(listed)?.id).toBe("r2");
    expect(newerRelease(owned(3, 2))).toBeNull();
    expect(newerRelease(owned(1, null))).toBeNull();
  });

  it("利用できないアイテムには出さない", () => {
    expect(newerRelease(owned(1, 3, false))).toBeNull();
  });
});
