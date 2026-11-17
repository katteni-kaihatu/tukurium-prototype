import { create } from "zustand";

/** 最近ワークスペースで開いたプロジェクト。新しい順に、この数まで覚える */
export const RECENT_LIMIT = 5;

export interface RecentProject {
  repoId: string;
  openedAt: number;
}

const key = (owner: string) => `tukurium.recent-projects.v1:${owner}`;

/** 開いたプロジェクトを先頭に足す。同じものは前の記録を消し、数を超えた古いものを捨てる */
export function pushRecent(
  list: readonly RecentProject[],
  repoId: string,
  openedAt: number,
): RecentProject[] {
  return [{ repoId, openedAt }, ...list.filter((entry) => entry.repoId !== repoId)].slice(
    0,
    RECENT_LIMIT,
  );
}

/** 保存した文字列を読む。形が違うものは捨てる */
export function parseRecent(raw: string | null): RecentProject[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry): entry is RecentProject =>
          !!entry &&
          typeof entry === "object" &&
          typeof entry.repoId === "string" &&
          typeof entry.openedAt === "number",
      )
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

interface RecentState {
  owner: string | null;
  list: RecentProject[];
  load(owner: string | null): void;
  record(repoId: string): void;
}

/** 最近開いたプロジェクトは、このブラウザに本人ごとに保存する（サーバーには送らない） */
export const useRecentProjects = create<RecentState>((set, get) => ({
  owner: null,
  list: [],
  load: (owner) => {
    if (owner === get().owner) return;
    let list: RecentProject[] = [];
    if (owner) {
      try {
        list = parseRecent(localStorage.getItem(key(owner)));
      } catch {
        list = [];
      }
    }
    set({ owner, list });
  },
  record: (repoId) => {
    const { owner, list } = get();
    if (!owner) return;
    if (list[0]?.repoId === repoId) return;
    const next = pushRecent(list, repoId, Date.now());
    try {
      localStorage.setItem(key(owner), JSON.stringify(next));
    } catch {
      // 保存できなくても、この画面の間は覚えておく
    }
    set({ list: next });
  },
}));
