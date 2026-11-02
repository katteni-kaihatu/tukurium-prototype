import type {
  PanelPublic,
  Participant,
  SessionInfo,
  SessionSummary,
  UserInfo,
} from "@tukurium/shared";
import { create } from "zustand";
import { type ConnectionStatus, ServerClient } from "../net/ServerClient";

export type RemotePanel = PanelPublic & { restricted: boolean };

interface AppState {
  client: ServerClient;
  myName: string;
  me: UserInfo | null;
  status: ConnectionStatus;
  sessions: SessionSummary[];
  session: SessionInfo | null;
  participants: Record<string, Participant>;
  /** 他の参加者が開いているパネル（権限に合わせて伏せられたもの） */
  remotePanels: Record<string, RemotePanel[]>;
  /** セッションが閉じられた理由（表示用） */
  closedReason: string | null;
  /** セッションの世界のログ（適用の結果など） */
  sessionLogs: { message: string; level: "log" | "error" }[];
  setName(name: string): void;
}

const NAME_KEY = "tukurium.name";

function loadName(): string {
  const fallback = `ゲスト${Math.floor(1000 + Math.random() * 9000)}`;
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) return saved;
    localStorage.setItem(NAME_KEY, fallback);
  } catch {
    // 保存できなくても使える
  }
  return fallback;
}

const initialName = loadName();
const client = new ServerClient(initialName);

export const useApp = create<AppState>((set) => ({
  client,
  myName: initialName,
  me: null,
  status: client.status,
  sessions: [],
  session: null,
  participants: {},
  remotePanels: {},
  closedReason: null,
  sessionLogs: [],
  setName: (name) => {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // 保存できなくても使える
    }
    client.rename(name);
    set({ myName: name });
  },
}));

client.onStatus((status) => useApp.setState({ status }));
client.on((msg) => {
  switch (msg.t) {
    case "welcome":
      useApp.setState({ me: msg.you, myName: msg.you.name });
      break;
    case "sessions":
      useApp.setState({ sessions: msg.sessions });
      break;
    case "session":
      useApp.setState({
        session: msg.session,
        participants: Object.fromEntries(msg.participants.map((p) => [p.id, p])),
        closedReason: null,
      });
      break;
    case "session.closed":
      useApp.setState({
        session: null,
        participants: {},
        remotePanels: {},
        closedReason: msg.reason,
      });
      break;
    case "joined":
      useApp.setState((s) => ({
        participants: { ...s.participants, [msg.participant.id]: msg.participant },
      }));
      break;
    case "left":
      useApp.setState((s) => {
        const { [msg.id]: _p, ...participants } = s.participants;
        const { [msg.id]: _r, ...remotePanels } = s.remotePanels;
        return { participants, remotePanels };
      });
      break;
    case "panels":
      useApp.setState((s) => ({ remotePanels: { ...s.remotePanels, [msg.userId]: msg.panels } }));
      break;
  }
});

// 開発時のみ：E2E テストやデバッグからストアを参照できるようにする
if (import.meta.env.DEV) (window as { __app?: typeof useApp }).__app = useApp;
