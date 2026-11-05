import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  messages: new Set<(message: unknown) => void>(),
  statuses: new Set<(status: string) => void>(),
  app: { session: { id: "s_room" } as { id: string } | null, status: "online" },
  workspace: { workspaceId: null as string | null, ready: false, openRepo: vi.fn() },
}));
vi.mock("../app/store", () => ({
  useApp: {
    getState: () => ({
      ...fake.app,
      client: {
        on: (fn: (message: unknown) => void) => {
          fake.messages.add(fn);
          return () => fake.messages.delete(fn);
        },
        onStatus: (fn: (status: string) => void) => {
          fake.statuses.add(fn);
          return () => fake.statuses.delete(fn);
        },
      },
    }),
  },
}));
vi.mock("../workspace/store", () => ({
  useWorkspace: { getState: () => fake.workspace, setState: vi.fn() },
}));

import { beginEditing, editProject } from "./editing";
import { useMainMenu } from "./store";

const receive = (message: unknown) => {
  for (const fn of fake.messages) fn(message);
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fake.messages.clear();
  fake.statuses.clear();
  fake.app.session = { id: "s_room" };
  fake.app.status = "online";
  fake.workspace.workspaceId = null;
  fake.workspace.ready = false;
  useMainMenu.setState(useMainMenu.getInitialState(), true);
  useMainMenu.getState().showProject("/p/project");
});
afterEach(() => vi.useRealTimers());

describe("セッションに残ったまま編集を始める", () => {
  it("対象のワークスペースを受け取ってからメニューを閉じる", () => {
    editProject("project");
    expect(fake.workspace.openRepo).toHaveBeenCalledWith("project");
    receive({ t: "ws.created", workspaceId: "w_target" });
    receive({ t: "ws.doc", workspaceId: "w_other" });
    expect(useMainMenu.getState().open).toBe(true);
    receive({ t: "ws.doc", workspaceId: "w_target" });
    expect(useMainMenu.getState()).toMatchObject({ open: false, editingPending: false });
    expect(fake.app.session?.id).toBe("s_room");
    expect(fake.messages.size).toBe(0);
  });
  it("既に開いているプロジェクトは新しい文書を待たない", () => {
    fake.workspace.workspaceId = "w_existing";
    fake.workspace.ready = true;
    beginEditing(() => receive({ t: "ws.created", workspaceId: "w_existing" }));
    expect(useMainMenu.getState()).toMatchObject({ open: false, editingPending: false });
  });
  it("拒否されたらメニューに理由を残し、再試行できる", () => {
    editProject("project");
    receive({ t: "ws.created", workspaceId: "w_target" });
    receive({ t: "ws.denied", workspaceId: "w_target", reason: "権限がありません" });
    expect(useMainMenu.getState()).toMatchObject({
      open: true,
      editingPending: false,
      editingError: "権限がありません",
    });
    editProject("project");
    expect(fake.workspace.openRepo).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(15000);
    expect(useMainMenu.getState().editingPending).toBe(false);
    expect(fake.messages.size).toBe(0);
  });
  it("未参加ならプロジェクトを開かずにセッションの選択へ進む", () => {
    fake.app.session = null;
    editProject("project");
    expect(fake.workspace.openRepo).not.toHaveBeenCalled();
    expect(useMainMenu.getState()).toMatchObject({
      open: true,
      page: "sessions",
      projectPath: "/p/project",
      editAfterJoin: "project",
    });
  });
});
