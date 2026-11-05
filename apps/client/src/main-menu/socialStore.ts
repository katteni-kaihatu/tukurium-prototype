import { useEffect } from "react";
import { create } from "zustand";
import { useApp } from "../app/store";
import { api, type SocialState } from "../net/api";

interface State {
  owner: string | null;
  data: SocialState | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
}
const initial: State = { owner: null, data: null, loading: false, error: null, busy: false };
export const useSocial = create<State>(() => initial);
let generation = 0;

export function useSocialConnection() {
  const id = useApp((s) => s.me?.id ?? null);
  const status = useApp((s) => s.status);
  const client = useApp((s) => s.client);
  useEffect(() => {
    if (useSocial.getState().owner !== id) {
      generation++;
      useSocial.setState({ ...initial, owner: id });
    }
    if (id && status === "online") void refreshSocial();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = client.on((msg) => {
      if (msg.t !== "social.changed" || !id) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refreshSocial(), 50);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [id, status, client]);
}

export async function refreshSocial() {
  const owner = useSocial.getState().owner;
  if (!owner) return;
  const seq = ++generation;
  useSocial.setState({ loading: true });
  try {
    const data = await api.social();
    if (seq === generation && owner === useSocial.getState().owner)
      useSocial.setState({ data, error: null });
  } catch (e) {
    if (seq === generation)
      useSocial.setState({
        error: e instanceof Error ? e.message : "フレンドを読み込めませんでした",
      });
  } finally {
    if (seq === generation) useSocial.setState({ loading: false });
  }
}

export async function changeSocial(action: () => Promise<unknown>): Promise<boolean> {
  const { owner, busy } = useSocial.getState();
  if (!owner || busy) return false;
  useSocial.setState({ busy: true, error: null });
  try {
    await action();
    if (owner !== useSocial.getState().owner) return false;
    await refreshSocial();
    return true;
  } catch (e) {
    if (owner === useSocial.getState().owner)
      useSocial.setState({ error: e instanceof Error ? e.message : "変更できませんでした" });
    return false;
  } finally {
    if (owner === useSocial.getState().owner) useSocial.setState({ busy: false });
  }
}

export const AVAILABILITY = {
  joinable: "参加 OK",
  online: "オンライン",
  ask: "声かけて",
  busy: "取り込み中",
} as const;
