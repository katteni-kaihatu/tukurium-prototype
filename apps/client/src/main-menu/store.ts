import { create } from "zustand";
import type { SessionEngine } from "../session/SessionEngine";

export const MENU_PAGES = [
  ["home", "ホーム"],
  ["friends", "フレンド"],
  ["sessions", "セッション"],
  ["items", "アイテム"],
  ["market", "マーケット"],
] as const;
export type MenuPage = (typeof MENU_PAGES)[number][0];

interface MenuState {
  open: boolean;
  page: MenuPage;
  recall: number;
  engine: SessionEngine | null;
  queries: Record<MenuPage, string>;
  selected: Partial<Record<MenuPage, string>>;
  scroll: Partial<Record<MenuPage, number>>;
  pendingSession: boolean;
  sessionError: string | null;
  returnAfterJoin: MenuPage | null;
  show(page?: MenuPage): void;
  close(): void;
  toggle(): void;
  selectPage(page: MenuPage): void;
  setQuery(page: MenuPage, query: string): void;
  select(page: MenuPage, id: string | undefined): void;
}

/** 本人だけのメニュー表示。ワークスペースの破棄やパネル配信には含めない。 */
export const useMainMenu = create<MenuState>((set, get) => ({
  open: false,
  page: "home",
  recall: 0,
  engine: null,
  queries: { home: "", friends: "", sessions: "", items: "", market: "" },
  selected: {},
  scroll: {},
  pendingSession: false,
  sessionError: null,
  returnAfterJoin: null,
  show: (page) => set((s) => ({ open: true, page: page ?? s.page, recall: s.recall + 1 })),
  close: () => set({ open: false }),
  toggle: () => (get().open ? get().close() : get().show()),
  selectPage: (page) => set({ page }),
  setQuery: (page, query) => set((s) => ({ queries: { ...s.queries, [page]: query } })),
  select: (page, id) => set((s) => ({ selected: { ...s.selected, [page]: id } })),
}));
