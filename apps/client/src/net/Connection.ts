import { type ClientMessage, PROTOCOL_VERSION, ServerMessage } from "@tukurium/shared";

export type ConnectionStatus = "connecting" | "online" | "offline";

export interface ConnectionHandlers {
  onMessage(msg: ServerMessage): void;
  onStatus(status: ConnectionStatus): void;
}

/** サーバーとの WebSocket。切れたら少しずつ間隔を空けて再接続する。 */
export class Connection {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly name: string,
    private readonly handlers: ConnectionHandlers,
    private readonly url = defaultUrl(),
  ) {
    this.open();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  private open(): void {
    this.handlers.onStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.send({ t: "hello", protocol: PROTOCOL_VERSION, name: this.name });
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
      if (parsed.data.t === "welcome") this.handlers.onStatus("online");
      this.handlers.onMessage(parsed.data);
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.closed) return;
      this.handlers.onStatus("offline");
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), delay);
    };
  }
}

function defaultUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
