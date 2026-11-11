import { create } from "zustand";
import type { SessionEngine } from "../session/SessionEngine";

export const MENU_PAGES = [
  ["home", "ホーム"],
  ["friends", "フレンド"],
  ["sessions", "セッション"],
  ["worlds", "ワールド"],
  ["items", "アイテム"],
  ["market", "マーケット"],
] as const;
export type MenuPage = (typeof MENU_PAGES)[number][0];

export const TOOL_WINDOWS = [
  ...MENU_PAGES,
  ["projects", "プロジェクト"],
  ["library", "ライブラリ"],
  ["workspaces", "ワークスペースを開く"],
  ["status", "ステータス"],
] as const;
export type ToolWindow = (typeof TOOL_WINDOWS)[number][0];
export const isMenuPage = (id: ToolWindow): id is MenuPage =>
  MENU_PAGES.some(([page]) => page === id);
type WindowState = { open: boolean; recall: number; focus: number };
const initialWindows = () =>
  Object.fromEntries(
    TOOL_WINDOWS.map(([id]) => [id, { open: false, recall: 0, focus: 0 }]),
  ) as Record<ToolWindow, WindowState>;

interface MenuState {
  windows: Record<ToolWindow, WindowState>;
  activeWindow: ToolWindow | null;
  focusRequest: { id: ToolWindow; seq: number } | null;
  workspaceRecall: number;
  order: ToolWindow[];
  showWindow(id: ToolWindow, recall?: boolean): void;
  activate(id: ToolWindow): void;
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
  projectPath: string | null;
  projectHistory: string[];
  editAfterJoin: string | null;
  editingPending: boolean;
  editingError: string | null;
  showProject(path: string): void;
  backProject(): void;
  show(page?: MenuPage): void;
  close(id?: ToolWindow): void;
  toggle(): void;
  selectPage(page: MenuPage): void;
  setQuery(page: MenuPage, query: string): void;
  select(page: MenuPage, id: string | undefined): void;
}

/** 本人だけのメニュー表示。ワークスペースの破棄やパネル配信には含めない。 */
export const useMainMenu = create<MenuState>((set, get) => ({
  windows: initialWindows(),
  activeWindow: null,
  focusRequest: null,
  workspaceRecall: 0,
  order: [],
  open: false,
  page: "home",
  recall: 0,
  engine: null,
  queries: { home: "", friends: "", sessions: "", worlds: "", items: "", market: "" },
  selected: {},
  scroll: {},
  pendingSession: false,
  sessionError: null,
  returnAfterJoin: null,
  projectPath: null,
  projectHistory: [],
  editAfterJoin: null,
  editingPending: false,
  editingError: null,
  showWindow: (id, recall = true) =>
    set((s) => {
      const previous = s.windows[id];
      const shouldRecall = recall || !previous.open;
      return {
        open: true,
        activeWindow: id,
        focusRequest: { id, seq: (s.focusRequest?.seq ?? 0) + 1 },
        page: isMenuPage(id) ? id : s.page,
        recall: s.recall + (shouldRecall ? 1 : 0),
        order: [...s.order.filter((window) => window !== id), id],
        windows: {
          ...s.windows,
          [id]: {
            open: true,
            recall: previous.recall + (shouldRecall ? 1 : 0),
            focus: previous.focus + 1,
          },
        },
      };
    }),
  activate: (id) =>
    set((s) =>
      s.activeWindow === id
        ? s
        : { activeWindow: id, order: [...s.order.filter((window) => window !== id), id] },
    ),
  showProject: (path) => {
    if (path === "/workspaces") {
      get().showWindow("workspaces", false);
      return;
    }
    set((s) => ({
      projectPath: path,
      projectHistory:
        s.projectPath && s.projectPath !== path
          ? [...s.projectHistory, s.projectPath]
          : s.projectHistory,
    }));
    get().showWindow("projects", false);
  },
  backProject: () =>
    set((s) => ({
      projectPath: s.projectHistory.at(-1) ?? "/u/me",
      projectHistory: s.projectHistory.slice(0, -1),
    })),
  show: (page) => get().showWindow(page ?? get().page),
  close: (id) =>
    set((s) => {
      const target = id ?? s.activeWindow;
      if (!target) return s;
      const windows = { ...s.windows, [target]: { ...s.windows[target], open: false } };
      const order = s.order.filter((window) => window !== target && windows[window].open);
      return { windows, order, activeWindow: order.at(-1) ?? null, open: order.length > 0 };
    }),
  toggle: () => (get().windows.home.open ? get().close("home") : get().show("home")),
  selectPage: (page) => {
    set({ editAfterJoin: null });
    get().showWindow(page, false);
  },
  setQuery: (page, query) => set((s) => ({ queries: { ...s.queries, [page]: query } })),
  select: (page, id) => set((s) => ({ selected: { ...s.selected, [page]: id } })),
}));
