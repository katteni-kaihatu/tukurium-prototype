import { create } from "zustand";
import { api, type RepoMeta } from "../net/api";

interface ReadableRepos {
  owner: string | null;
  repos: RepoMeta[];
  /** 本人が読めるプロジェクトの一覧を読み直す（持ち主が変わったら前の一覧は捨てる） */
  refresh(owner: string | null): Promise<void>;
}

let request = 0;

/** 左の欄で使う、本人が読めるプロジェクトの一覧（サーバーの GET /api/repos） */
export const useReadableRepos = create<ReadableRepos>((set, get) => ({
  owner: null,
  repos: [],
  refresh: async (owner) => {
    const seq = ++request;
    if (owner !== get().owner) set({ owner, repos: [] });
    if (!owner) return;
    try {
      const repos = await api.repos();
      if (seq === request) set({ repos });
    } catch {
      // 読めなければ、前の一覧のままにする
    }
  },
}));
