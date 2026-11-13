import { parseValue, stringifyValue } from "@tukurium/eks";
import { ProjectDoc } from "@tukurium/repo-model";
import {
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionInfo,
  type SessionSummary,
  type WorkspaceRole,
} from "@tukurium/shared";
import * as Y from "yjs";
import type { Hub } from "../hub";

/** サーバーから届いた更新の印（自分の変更と区別して、送り返さないため） */
const REMOTE = Symbol("remote");

type Wait = { match: (m: ServerMessage) => unknown; resolve: (v: unknown) => void };

/**
 * サーバーの中で動く、AI エージェントの参加者（ADR 0054）。
 * hub へ内部の接続としてつなぎ、人のクライアントと同じメッセージ（名乗る・セッションに入る・
 * ワークスペースを開く・Yjs の更新）で制作する。編集は人の画面にそのまま届き、差分・元に戻すも同じ。
 * ホストにはならず、保存はできない（hub が断る）。
 */
export class AgentClient {
  private readonly conn: { onMessage(raw: string): void; onClose(): void };
  private waits: Wait[] = [];
  private closed = false;
  me: { id: string; name: string } | null = null;
  sessions: SessionSummary[] = [];
  session: SessionInfo | null = null;
  /** 開いているワークスペース（一度に一つ） */
  workspace: { id: string; role: WorkspaceRole; project: ProjectDoc } | null = null;
  /** 直近のエラー（hub が断ったときなど） */
  errors: string[] = [];

  constructor(hub: Hub) {
    this.conn = hub.connect(
      { send: (data) => this.receive(data), close: () => this.close() },
      { agent: true },
    );
  }

  /** 名乗る。エージェントは人とは別の利用者になる（名前に「エージェント」を付ける） */
  async hello(name: string): Promise<void> {
    const label = name.includes("エージェント") ? name : `エージェント（${name}）`;
    const got = this.waitFor((m) => (m.t === "welcome" ? m : null));
    this.send({ t: "hello", protocol: PROTOCOL_VERSION, name: label.slice(0, 40) });
    const welcome = (await got) as Extract<ServerMessage, { t: "welcome" }>;
    this.me = welcome.you;
  }

  async joinSession(sessionId: string): Promise<SessionInfo> {
    const got = this.waitFor((m) =>
      m.t === "session" && m.session.id === sessionId
        ? m.session
        : m.t === "session.rejected" && m.sessionId === sessionId
          ? new Error(m.message)
          : null,
    );
    this.send({ t: "session.join", sessionId });
    const result = await got;
    if (result instanceof Error) throw result;
    return result as SessionInfo;
  }

  async openWorkspace(workspaceId: string): Promise<{ role: WorkspaceRole; project: ProjectDoc }> {
    if (this.workspace?.id === workspaceId) return this.workspace;
    if (this.workspace) this.send({ t: "ws.close", workspaceId: this.workspace.id });
    this.workspace = null;
    const got = this.waitFor((m) =>
      m.t === "ws.doc" && m.workspaceId === workspaceId
        ? m
        : m.t === "ws.denied" && m.workspaceId === workspaceId
          ? new Error(m.reason)
          : null,
    );
    this.send({ t: "ws.open", workspaceId });
    const result = await got;
    if (result instanceof Error) throw result;
    const docMsg = result as Extract<ServerMessage, { t: "ws.doc" }>;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(docMsg.update, "base64"), REMOTE);
    // 自分の変更だけを送る
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      this.send({ t: "ws.update", workspaceId, update: Buffer.from(update).toString("base64") });
    });
    this.workspace = { id: workspaceId, role: docMsg.role, project: new ProjectDoc(doc) };
    return this.workspace;
  }

  /** 送ったメッセージを hub が処理し終えるのを待つ（断られたらエラーが errors に残る） */
  async settle(): Promise<string[]> {
    const before = this.errors.length;
    const token = `settle-${Math.random()}`;
    const got = this.waitFor((m) =>
      m.t === "session.rejected" && m.requestId === token ? true : null,
    );
    // 存在しないセッションへの参加を、印として最後に送る（順番に処理されるので、前のものは済んでいる）
    this.send({ t: "session.join", sessionId: "s_settle_probe", requestId: token });
    await got;
    return this.errors.slice(before);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waits) w.resolve(new Error("接続を閉じました"));
    this.waits = [];
    this.conn.onClose();
  }

  private send(msg: Record<string, unknown>): void {
    if (this.closed) throw new Error("接続を閉じました。もう一度 join_session してください");
    this.conn.onMessage(stringifyValue(msg));
  }

  private waitFor(match: (m: ServerMessage) => unknown, timeoutMs = 10_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waits = this.waits.filter((w) => w !== entry);
        reject(new Error("サーバーからの返事がありませんでした"));
      }, timeoutMs);
      const entry: Wait = {
        match,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      };
      this.waits.push(entry);
    });
  }

  private receive(raw: string): void {
    const m = parseValue(raw) as ServerMessage;
    if (m.t === "sessions") this.sessions = m.sessions;
    if (m.t === "session") this.session = m.session;
    if (m.t === "session.closed") this.session = null;
    if (m.t === "error") this.errors.push(m.message);
    if (m.t === "ws.update" && this.workspace?.id === m.workspaceId) {
      Y.applyUpdate(this.workspace.project.doc, Buffer.from(m.update, "base64"), REMOTE);
    }
    if (m.t === "ws.role" && this.workspace?.id === m.workspaceId) {
      if (m.role) this.workspace.role = m.role;
      else this.workspace = null;
    }
    if (m.t === "ws.ended" && this.workspace?.id === m.workspaceId) {
      this.workspace.project.doc.destroy();
      this.workspace = null;
    }
    for (const w of [...this.waits]) {
      const v = w.match(m);
      if (v !== null && v !== undefined) {
        this.waits = this.waits.filter((x) => x !== w);
        w.resolve(v);
      }
    }
  }
}
