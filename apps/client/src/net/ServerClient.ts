import { parseValue, stringifyValue } from "@tukurium/eks";
import {
  type ClientMessage,
  PROTOCOL_VERSION,
  ServerMessage,
  type UserInfo,
} from "@tukurium/shared";

export type ConnectionStatus = "connecting" | "online" | "offline";

type Listener = (msg: ServerMessage) => void;

/**
 * サーバーとの接続（アプリ全体で 1 つ）。
 * - 本人はログインの Cookie で決まる（ADR 0074）。接続は読み込んだらすぐ始める（store.ts）。
 *   ログインしていなければサーバーが auth.required を返して閉じるので、つなぎ直さない。
 *   画面の準備（3D）が重いと、あとから接続を始めても、つながった知らせを処理するのが遅れる
 * - 切れたら少しずつ間隔を空けて再接続する。
 * - 受け取ったメッセージは購読者に配る。接続し直したときは onReconnect で状態を取り直す。
 */
export class ServerClient {
  status: ConnectionStatus = "connecting";
  me: UserInfo | null = null;
  joinedSessionId: string | null = null;
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly welcomeListeners = new Set<() => void>();
  private started = false;
  private welcomedOnce = false;
  /**
   * 入っていたのにログインが切れたとき（ほかのタブでログアウトした・期限が切れた）。
   * 最初からログインしていないときは呼ばない（ログインの画面が出ている）
   */
  onLoggedOut: () => void = () => location.reload();

  constructor(private readonly url = defaultUrl()) {}

  /** 接続を始める（ログインを確かめたあと、一度だけ） */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.open();
  }

  send(msg: ClientMessage): void {
    if (msg.t === "session.leave") this.joinedSessionId = null;
    // フィールドの値を欠かさず運ぶため、タグ付きの JSON で送る（ADR 0065）
    if (this.ws?.readyState === WebSocket.OPEN && this.me) this.ws.send(stringifyValue(msg));
  }

  rename(name: string): void {
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
      ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }));
    };
    ws.onmessage = (ev) => {
      let data: unknown;
      try {
        data = parseValue(String(ev.data));
      } catch {
        return;
      }
      const parsed = ServerMessage.safeParse(data);
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.t === "session.entered") this.joinedSessionId = msg.sessionId;
      if (msg.t === "session.closed") this.joinedSessionId = null;
      if (msg.t === "auth.required") {
        this.close();
        if (this.welcomedOnce) this.onLoggedOut();
        return;
      }
      if (msg.t === "welcome") {
        this.welcomedOnce = true;
        this.me = msg.you;
        this.setStatus("online");
        for (const fn of this.welcomeListeners) fn();
      }
      for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.me = null;
      this.joinedSessionId = null;
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
