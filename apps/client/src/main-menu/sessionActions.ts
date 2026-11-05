import type { ClientMessage } from "@tukurium/shared";
import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import { useApp } from "../app/store";
import { resetSessionWorld } from "../session/sessionWorld";
import { useWorkspace } from "../workspace/store";
import { useMainMenu } from "./store";

/** サーバーが移動先を受理してから、古い制作・実行状態を片付ける。 */
export function useSessionLifecycle() {
  const client = useApp((s) => s.client);
  useEffect(
    () =>
      client.on((msg) => {
        if (msg.t === "session.entered" && useApp.getState().session?.id !== msg.sessionId) {
          useWorkspace.getState().leave();
          resetSessionWorld();
          useApp.setState({ session: null, participants: {}, remotePanels: {}, sessionLogs: [] });
        }
        if (msg.t === "session.rejected" && !msg.requestId) {
          useMainMenu.setState({ sessionError: msg.message });
          useMainMenu.getState().show("sessions");
        }
      }),
    [client],
  );
}

type SessionRequest = Extract<ClientMessage, { t: "session.create" | "session.join" }>;

export async function enterSession(
  request: SessionRequest,
  navigate: NavigateFunction,
): Promise<boolean> {
  const menu = useMainMenu.getState();
  const { client, session, me, status } = useApp.getState();
  if (menu.pendingSession) return false;
  if (request.t === "session.join" && session?.id === request.sessionId) {
    menu.close(menu.activeWindow ?? undefined);
    return true;
  }
  if (status !== "online") {
    useMainMenu.setState({ sessionError: "接続してからもう一度お試しください。" });
    return false;
  }
  if (
    session &&
    !window.confirm(
      session.owner === me?.id
        ? `「${session.name}」から移動しますか？ 持ち主が戻らなければ、元のセッションは閉じます。`
        : `「${session.name}」から移動しますか？`,
    )
  )
    return false;
  useMainMenu.setState({ pendingSession: true, sessionError: null });
  const requestId = crypto.randomUUID();
  try {
    const id = await new Promise<string>((resolve, reject) => {
      let target: string | null = null;
      const finish = (error?: string, id?: string) => {
        clearTimeout(timer);
        off();
        offStatus();
        if (error) reject(new Error(error));
        else if (id) resolve(id);
      };
      const off = client.on((msg) => {
        if (msg.t === "session.entered" && msg.requestId === requestId) target = msg.sessionId;
        if (msg.t === "session.rejected" && msg.requestId === requestId) finish(msg.message);
        if (msg.t === "session" && msg.session.id === target) finish(undefined, target);
      });
      const offStatus = client.onStatus((s) => {
        if (s !== "online") finish("接続が切れました。再接続後に参加先を確認してください。");
      });
      const timer = setTimeout(
        () => finish("参加結果を確認できませんでした。一覧を更新してください。"),
        15000,
      );
      client.send({ ...request, requestId });
    });
    navigate(`/s/${id}`);
    const edit = useMainMenu.getState().editAfterJoin;
    if (edit) {
      useMainMenu.setState({ returnAfterJoin: null });
      useMainMenu.getState().showProject("/workspaces");
      return true;
    }
    const returnPage = useMainMenu.getState().returnAfterJoin;
    if (returnPage) {
      useMainMenu.setState({ returnAfterJoin: null });
      if (menu.activeWindow) useMainMenu.getState().close(menu.activeWindow);
      useMainMenu.getState().showWindow(returnPage, false);
    } else if (menu.activeWindow) useMainMenu.getState().close(menu.activeWindow);
    return true;
  } catch (error) {
    useMainMenu.setState({
      sessionError: error instanceof Error ? error.message : "参加できませんでした。",
    });
    return false;
  } finally {
    useMainMenu.setState({ pendingSession: false });
  }
}
