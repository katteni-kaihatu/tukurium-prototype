import type { ClientMessage } from "@tukurium/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { useApp } from "../app/store";
import { api, type MarketPage, type OwnedItem, type Work, type WorkDetail } from "../net/api";
import { useWorkspace } from "../workspace/store";
import { useMainMenu } from "./store";

type PlacementRequest = Extract<ClientMessage, { t: "placeRelease" }>;
interface Attempt {
  request: PlacementRequest;
  workId: string;
  name: string;
  started: number;
}
interface CatalogState {
  owner: string | null;
  owned: OwnedItem[];
  ownedLoaded: boolean;
  ownedLoading: boolean;
  ownedError: string | null;
  market: MarketPage | null;
  marketQuery: string;
  marketTags: string[];
  marketLoading: boolean;
  marketError: string | null;
  busy: string | null;
  message: string | null;
  actionError: string | null;
  retry: Attempt | null;
  recent: Work[];
  recentLoading: boolean;
  recentError: string | null;
  detail: WorkDetail | null;
  detailFor: string | null;
  detailLoading: boolean;
  detailError: string | null;
  mine: Work[];
  mineLoading: boolean;
  mineError: string | null;
}
const initial: CatalogState = {
  owner: null,
  owned: [],
  ownedLoaded: false,
  ownedLoading: false,
  ownedError: null,
  market: null,
  marketQuery: "",
  marketTags: [],
  marketLoading: false,
  marketError: null,
  busy: null,
  message: null,
  actionError: null,
  retry: null,
  recent: [],
  recentLoading: false,
  recentError: null,
  detail: null,
  detailFor: null,
  detailLoading: false,
  detailError: null,
  mine: [],
  mineLoading: false,
  mineError: null,
};
export const useCatalog = create<CatalogState>(() => initial);
let marketRequest = 0;
let ownedRequest = 0;
let recentRequest = 0;
let detailRequest = 0;
let mineRequest = 0;
let marketAbort: AbortController | null = null;

export function useCatalogConnection() {
  const id = useApp((s) => s.me?.id ?? null);
  const owner = useCatalog((s) => s.owner);
  const status = useApp((s) => s.status);
  const open = useMainMenu((s) => s.open);
  useEffect(() => {
    if (owner === id) return;
    marketAbort?.abort();
    marketRequest++;
    ownedRequest++;
    recentRequest++;
    detailRequest++;
    mineRequest++;
    const previous = owner;
    useCatalog.setState({ ...initial, owner: id });
    if (previous)
      useMainMenu.setState({
        queries: { home: "", friends: "", sessions: "", worlds: "", items: "", market: "" },
        selected: {},
        scroll: {},
        returnAfterJoin: null,
      });
  }, [id, owner]);
  useEffect(() => {
    if (open && id && owner === id && status === "online") void refreshOwned();
  }, [id, status, open, owner]);
}

export async function refreshOwned() {
  const owner = useCatalog.getState().owner;
  if (!owner) return;
  const seq = ++ownedRequest;
  useCatalog.setState({ ownedLoading: true, ownedError: null });
  try {
    const owned = await api.ownedItems();
    if (seq === ownedRequest && owner === useCatalog.getState().owner)
      useCatalog.setState({ owned, ownedLoaded: true });
  } catch (e) {
    if (seq === ownedRequest) useCatalog.setState({ ownedError: errorMessage(e) });
  } finally {
    if (seq === ownedRequest) useCatalog.setState({ ownedLoading: false });
  }
}

export async function searchMarket(query: string, offset = 0, tags: string[] = []) {
  marketAbort?.abort();
  const abort = new AbortController();
  marketAbort = abort;
  const seq = ++marketRequest;
  const cached = useCatalog.getState();
  const sameSearch =
    cached.marketQuery === query && JSON.stringify(cached.marketTags) === JSON.stringify(tags);
  useCatalog.setState({
    marketLoading: true,
    marketQuery: query,
    marketTags: tags,
    market: sameSearch ? cached.market : null,
    marketError: null,
  });
  try {
    const market = await api.market(query, offset, abort.signal, tags);
    if (seq !== marketRequest) return;
    const previous = useCatalog.getState().market;
    const items =
      offset && previous
        ? [...new Map([...previous.items, ...market.items].map((w) => [w.id, w])).values()]
        : market.items;
    useCatalog.setState({ market: { ...market, items } });
  } catch (e) {
    if (seq === marketRequest && !abort.signal.aborted)
      useCatalog.setState({ marketError: errorMessage(e) });
  } finally {
    if (seq === marketRequest) useCatalog.setState({ marketLoading: false });
  }
}

export async function acquire(work: Work) {
  const { owner, busy } = useCatalog.getState();
  if (!owner || busy || !work.latest) return;
  useCatalog.setState({ busy: work.id, message: null, actionError: null });
  try {
    const item = await api.acquireItem(work.id, work.latest.id);
    if (owner !== useCatalog.getState().owner) return;
    ownedRequest++;
    useCatalog.setState((s) => ({
      owned: [item, ...s.owned.filter((i) => i.workId !== item.workId)],
      ownedLoaded: true,
      ownedLoading: false,
      message: `「${work.name}」を入手しました。アイテムから取り出せます。`,
    }));
    void refreshOwned();
  } catch (e) {
    if (owner === useCatalog.getState().owner)
      useCatalog.setState({ actionError: errorMessage(e) });
  } finally {
    if (owner === useCatalog.getState().owner) useCatalog.setState({ busy: null });
  }
}

/** 所持している版を、新しい版に替える。入手日は変わらない。 */
export async function updateOwned(item: OwnedItem, releaseId: string) {
  const { owner, busy } = useCatalog.getState();
  if (!owner || busy) return;
  const name = item.work?.name ?? "アイテム";
  useCatalog.setState({ busy: item.workId, message: null, actionError: null });
  try {
    const updated = await api.updateItem(item.workId, releaseId);
    if (owner !== useCatalog.getState().owner) return;
    ownedRequest++;
    useCatalog.setState((s) => ({
      owned: s.owned.map((i) => (i.workId === updated.workId ? updated : i)),
      ownedLoading: false,
      message: `「${name}」を v${updated.release?.version ?? "?"} にアップデートしました。`,
    }));
  } catch (e) {
    if (owner === useCatalog.getState().owner)
      useCatalog.setState({ actionError: errorMessage(e) });
  } finally {
    if (owner === useCatalog.getState().owner) useCatalog.setState({ busy: null });
  }
}

/** 所持一覧から消す。セッションに出ている配置は残る。マーケットからまた入手できる。 */
export async function removeOwned(item: OwnedItem) {
  const { owner, busy } = useCatalog.getState();
  if (!owner || busy) return;
  const name = item.work?.name ?? "アイテム";
  useCatalog.setState({ busy: item.workId, message: null, actionError: null });
  try {
    await api.removeItem(item.workId);
    if (owner !== useCatalog.getState().owner) return;
    ownedRequest++;
    useCatalog.setState((s) => ({
      owned: s.owned.filter((i) => i.workId !== item.workId),
      ownedLoading: false,
      retry: s.retry?.workId === item.workId ? null : s.retry,
      message: `「${name}」を所持アイテムから消しました。`,
    }));
    useMainMenu.setState((s) =>
      s.selected.items === item.workId ? { selected: { ...s.selected, items: undefined } } : s,
    );
  } catch (e) {
    if (owner === useCatalog.getState().owner)
      useCatalog.setState({ actionError: errorMessage(e) });
  } finally {
    if (owner === useCatalog.getState().owner) useCatalog.setState({ busy: null });
  }
}

/** タグは公開作品の情報。所持している版には手を加えない。 */
export async function saveWorkTags(workId: string, tags: string[]) {
  const owner = useCatalog.getState().owner;
  const updated = await api.updateWork(workId, { tags });
  if (owner !== useCatalog.getState().owner) return;
  const merge = (work: Work) => (work.id === workId ? { ...work, ...updated } : work);
  useCatalog.setState((s) => ({
    owned: s.owned.map((item) => (item.work ? { ...item, work: merge(item.work) } : item)),
    market: s.market ? { ...s.market, items: s.market.items.map(merge) } : null,
    recent: s.recent.map(merge),
    mine: s.mine.map(merge),
    detail: s.detail?.id === workId ? { ...s.detail, ...updated } : s.detail,
  }));
  void refreshOwned();
  const state = useCatalog.getState();
  if (state.market) void searchMarket(state.marketQuery, 0, state.marketTags);
}

export async function takeOut(item: OwnedItem, retryAttempt?: Attempt) {
  const { session, client, status } = useApp.getState();
  const state = useCatalog.getState();
  if (state.busy) return;
  if (!session) {
    useMainMenu.setState((s) => ({
      returnAfterJoin: "items",
      selected: { ...s.selected, items: item.workId },
    }));
    useMainMenu.getState().selectPage("sessions");
    return;
  }
  if (status !== "online" || (!item.available && !retryAttempt)) return;
  if (state.retry && !retryAttempt) {
    useCatalog.setState({
      actionError: "前の取り出し結果を確認してから、次のアイテムを取り出してください。",
    });
    return;
  }
  const pose = useMainMenu.getState().engine?.pose();
  const origin = useWorkspace.getState().placePoint?.() ?? {
    position: pose
      ? ([
          pose.position[0] - Math.sin(pose.yaw) * 2,
          0,
          pose.position[2] - Math.cos(pose.yaw) * 2,
        ] as [number, number, number])
      : ([0, 0, 0] as [number, number, number]),
    yaw: pose?.yaw ?? 0,
  };
  const attempt = retryAttempt ?? {
    workId: item.workId,
    name: item.work?.name ?? "アイテム",
    started: Date.now(),
    request: {
      t: "placeRelease",
      releaseId: item.releaseId,
      sessionId: session.id,
      requestId: crypto.randomUUID(),
      ...origin,
    },
  };
  if (attempt.request.sessionId !== session.id || Date.now() - attempt.started > 4 * 60_000) {
    useCatalog.setState({
      retry: null,
      actionError:
        "取り出し先が変わったか、確認期限が過ぎました。配置済みのアイテムを確認してください。",
    });
    return;
  }
  const owner = state.owner;
  useCatalog.setState({ busy: item.workId, message: null, actionError: null, retry: null });
  let definite = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: string) => {
        clearTimeout(timer);
        off();
        offStatus();
        if (error) reject(new Error(error));
        else resolve();
      };
      const off = client.on((msg) => {
        if (
          msg.t !== "placement.result" ||
          msg.requestId !== attempt.request.requestId ||
          msg.sessionId !== attempt.request.sessionId
        )
          return;
        definite = true;
        if (msg.error || !msg.placementId) finish(msg.error ?? "取り出しを確認できませんでした");
        else finish();
      });
      const offStatus = client.onStatus((next) => {
        if (next !== "online")
          finish("接続が切れました。再接続後に取り出し結果を確認してください。");
      });
      const timer = setTimeout(
        () => finish("結果を受け取れませんでした。「結果を確認」で同じ取り出しを確認できます。"),
        10000,
      );
      client.send(attempt.request);
    });
    if (owner === useCatalog.getState().owner)
      useCatalog.setState({
        message: `「${attempt.name}」を「${session.name}」に取り出しました。`,
      });
  } catch (e) {
    if (owner === useCatalog.getState().owner)
      useCatalog.setState({ actionError: errorMessage(e), retry: definite ? null : attempt });
  } finally {
    if (owner === useCatalog.getState().owner) useCatalog.setState({ busy: null });
  }
}

export async function loadWork(id: string) {
  const seq = ++detailRequest;
  useCatalog.setState({ detailLoading: true, detailError: null, detailFor: id });
  try {
    const detail = await api.work(id);
    if (seq === detailRequest) useCatalog.setState({ detail });
  } catch (e) {
    if (seq === detailRequest) useCatalog.setState({ detail: null, detailError: errorMessage(e) });
  } finally {
    if (seq === detailRequest) useCatalog.setState({ detailLoading: false });
  }
}

export async function loadMyWorks() {
  const owner = useCatalog.getState().owner;
  if (!owner) return;
  const seq = ++mineRequest;
  useCatalog.setState({ mineLoading: true, mineError: null });
  try {
    const mine = await api.works(owner);
    if (seq === mineRequest && owner === useCatalog.getState().owner) useCatalog.setState({ mine });
  } catch (e) {
    if (seq === mineRequest) useCatalog.setState({ mineError: errorMessage(e) });
  } finally {
    if (seq === mineRequest) useCatalog.setState({ mineLoading: false });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "取得できませんでした。もう一度お試しください。";
}

export async function refreshRecent() {
  const seq = ++recentRequest;
  const owner = useCatalog.getState().owner;
  useCatalog.setState({ recentLoading: true, recentError: null });
  try {
    const page = await api.market();
    if (seq === recentRequest && owner === useCatalog.getState().owner)
      useCatalog.setState({ recent: page.items.slice(0, 4) });
  } catch (e) {
    if (seq === recentRequest) useCatalog.setState({ recentError: errorMessage(e) });
  } finally {
    if (seq === recentRequest) useCatalog.setState({ recentLoading: false });
  }
}
