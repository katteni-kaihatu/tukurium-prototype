import {
  type ClientMessage,
  PROTOCOL_VERSION,
  ServerMessage,
  type UserInfo,
} from "@tukurium/shared";

export type ConnectionStatus = "connecting" | "online" | "offline";

type Listener = (msg: ServerMessage) => void;

const TOKEN_KEY = "tukurium.token";

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * サーバーとの接続（アプリ全体で 1 つ）。
 * - 切れたら少しずつ間隔を空けて再接続し、トークンで同じ人として名乗り直す。
 * - 受け取ったメッセージは購読者に配る。接続し直したときは onReconnect で状態を取り直す。
 */
export class ServerClient {
  status: ConnectionStatus = "connecting";
  me: UserInfo | null = null;
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly welcomeListeners = new Set<() => void>();

  constructor(
    private name: string,
    private readonly url = defaultUrl(),
  ) {
    this.open();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.me) this.ws.send(JSON.stringify(msg));
  }

  rename(name: string): void {
    this.name = name;
    this.send({ t: "rename", name });
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** 名乗りが済んだとき（初回・再接続のたび）に呼ばれる */
  onWelcome(fn: () => void): () => void {
    this.welcomeListeners.add(fn);
    if (this.me && this.status === "online") fn();
    return () => this.welcomeListeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  private open(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      const token = storage()?.getItem(TOKEN_KEY) ?? undefined;
      ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, name: this.name, token }));
    };
    ws.onmessage = (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const parsed = ServerMessage.safeParse(data);
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.t === "welcome") {
        this.me = msg.you;
        storage()?.setItem(TOKEN_KEY, msg.token);
        this.setStatus("online");
        for (const fn of this.welcomeListeners) fn();
      }
      for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.me = null;
      if (this.closed) return;
      this.setStatus("offline");
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), delay);
    };
  }
}

function defaultUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
