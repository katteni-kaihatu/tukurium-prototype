import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketPage } from "../net/api";

const requests = vi.hoisted(() => ({ market: vi.fn(), ownedItems: vi.fn(), acquireItem: vi.fn() }));
vi.mock("../net/api", () => ({ api: requests }));
vi.mock("../app/store", () => ({ useApp: { getState: () => ({}) } }));
vi.mock("../workspace/store", () => ({ useWorkspace: { getState: () => ({}) } }));

import { refreshOwned, searchMarket, useCatalog } from "./catalogStore";

beforeEach(() => {
  vi.resetAllMocks();
  useCatalog.setState(useCatalog.getInitialState(), true);
});
describe("アイテムの取得結果", () => {
  it("新しい検索の後に届いた古い結果を使わない", async () => {
    let resolveOld: (page: MarketPage) => void = () => {};
    requests.market.mockImplementationOnce(
      () =>
        new Promise<MarketPage>((resolve) => {
          resolveOld = resolve;
        }),
    );
    requests.market.mockResolvedValueOnce({
      items: [],
      total: 2,
      offset: 0,
      limit: 24,
      nextOffset: null,
    });
    const old = searchMarket("前の検索");
    await searchMarket("新しい検索");
    resolveOld({ items: [], total: 10, offset: 0, limit: 24, nextOffset: null });
    await old;
    expect(useCatalog.getState().marketQuery).toBe("新しい検索");
    expect(useCatalog.getState().market?.total).toBe(2);
  });
  it("同じ検索語でも、先に選んだタグの結果が後から上書きしない", async () => {
    useCatalog.setState({
      market: { items: [], total: 99, offset: 0, limit: 24, nextOffset: null },
      marketTags: ["前のタグ"],
    });
    let resolveOld: (page: MarketPage) => void = () => {};
    requests.market.mockImplementationOnce(
      () =>
        new Promise<MarketPage>((resolve) => {
          resolveOld = resolve;
        }),
    );
    requests.market.mockResolvedValueOnce({
      items: [],
      total: 2,
      offset: 0,
      limit: 24,
      nextOffset: null,
    });
    const old = searchMarket("", 0, ["ゲーム"]);
    expect(useCatalog.getState().market).toBeNull();
    await searchMarket("", 0, ["道具"]);
    resolveOld({ items: [], total: 99, offset: 0, limit: 24, nextOffset: null });
    await old;
    expect(useCatalog.getState().marketTags).toEqual(["道具"]);
    expect(useCatalog.getState().market?.total).toBe(2);
  });
  it("アカウントが変わってから届いた所持一覧を使わない", async () => {
    let resolveOld: (items: unknown[]) => void = () => {};
    requests.ownedItems.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    useCatalog.setState({ owner: "person-a" });
    const old = refreshOwned();
    useCatalog.setState({ owner: "person-b", owned: [] });
    resolveOld([{ workId: "private-item" }]);
    await old;
    expect(useCatalog.getState().owned).toEqual([]);
    expect(useCatalog.getState().owner).toBe("person-b");
  });
});
