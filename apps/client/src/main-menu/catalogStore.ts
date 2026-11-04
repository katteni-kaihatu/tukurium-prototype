import type { ClientMessage } from "@tukurium/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { useApp } from "../app/store";
import { api, type MarketPage, type OwnedItem, type Work } from "../net/api";
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
  marketLoading: boolean;
  marketError: string | null;
  busy: string | null;
  message: string | null;
  actionError: string | null;
  retry: Attempt | null;
}
const initial: CatalogState = {
  owner: null,
  owned: [],
  ownedLoaded: false,
  ownedLoading: false,
  ownedError: null,
  market: null,
  marketQuery: "",
  marketLoading: false,
  marketError: null,
  busy: null,
  message: null,
  actionError: null,
  retry: null,
};
export const useCatalog = create<CatalogState>(() => initial);
let marketRequest = 0;
let ownedRequest = 0;
let marketAbort: AbortController | null = null;

export function useCatalogConnection() {
  const id = useApp((s) => s.me?.id ?? null);
  const status = useApp((s) => s.status);
  const open = useMainMenu((s) => s.open);
  useEffect(() => {
    if (useCatalog.getState().owner === id) return;
    marketAbort?.abort();
    marketRequest++;
    ownedRequest++;
    const previous = useCatalog.getState().owner;
    useCatalog.setState({ ...initial, owner: id });
    if (previous)
      useMainMenu.setState({
        queries: { home: "", friends: "", sessions: "", items: "", market: "" },
        selected: {},
        scroll: {},
      });
  }, [id]);
  useEffect(() => {
    if (open && id && status === "online") void refreshOwned();
  }, [id, status, open]);
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

export async function searchMarket(query: string, offset = 0) {
  marketAbort?.abort();
  const abort = new AbortController();
  marketAbort = abort;
  const seq = ++marketRequest;
  useCatalog.setState({ marketLoading: true, marketQuery: query, marketError: null });
  try {
    const market = await api.market(query, offset, abort.signal);
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

export async function takeOut(item: OwnedItem, retryAttempt?: Attempt) {
  const { session, client, status } = useApp.getState();
  const state = useCatalog.getState();
  if (state.busy) return;
  if (!session) {
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "取得できませんでした。もう一度お試しください。";
}
