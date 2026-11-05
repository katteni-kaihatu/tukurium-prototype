import { useApp } from "../app/store";
import { useWorkspace } from "../workspace/store";
import { useMainMenu } from "./store";

/** 編集を明示的に選んだときだけ開く。セッションの参加状態には触れない。 */
export function beginEditing(action: () => void | Promise<void>, workspaceId?: string) {
  const menu = useMainMenu.getState();
  const { client, session, status } = useApp.getState();
  if (menu.editingPending) return;
  if (!session || status !== "online") {
    useMainMenu.setState({ editingError: "セッションへの接続を確認してください。" });
    return;
  }
  useMainMenu.setState({ editingPending: true, editingError: null });
  useWorkspace.setState({ panelsHidden: false });
  let target = workspaceId;
  let settled = false;
  const finish = (error?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    off();
    offStatus();
    useMainMenu.setState({ editingPending: false, editingError: error ?? null });
    if (!error && menu.activeWindow) useMainMenu.getState().close(menu.activeWindow);
  };
  const off = client.on((msg) => {
    if (msg.t === "ws.created") {
      target = msg.workspaceId;
      if (useWorkspace.getState().workspaceId === target && useWorkspace.getState().ready) finish();
    }
    if (msg.t === "ws.doc" && msg.workspaceId === target) finish();
    if (msg.t === "ws.denied" && msg.workspaceId === target) finish(msg.reason);
    if (msg.t === "error") finish(msg.message);
    if (msg.t === "session.closed") finish("セッションが閉じられました。");
  });
  const offStatus = client.onStatus((state) => {
    if (state !== "online") finish("接続が切れました。もう一度お試しください。");
  });
  const timer = setTimeout(
    () => finish("ワークスペースを開けませんでした。もう一度お試しください。"),
    15000,
  );
  try {
    const result = action();
    if (result) void result.catch((error: Error) => finish(error.message));
    if (target && useWorkspace.getState().workspaceId === target && useWorkspace.getState().ready)
      finish();
  } catch (error) {
    finish(error instanceof Error ? error.message : String(error));
  }
}

export function editProject(repoId: string) {
  const menu = useMainMenu.getState();
  if (!useApp.getState().session) {
    menu.show("sessions");
    useMainMenu.setState({ editAfterJoin: repoId, returnAfterJoin: null });
    return;
  }
  beginEditing(() => useWorkspace.getState().openRepo(repoId));
}
