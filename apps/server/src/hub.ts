import { randomUUID } from "node:crypto";
import { ProjectDoc } from "@tukurium/repo-model";
import {
  ClientMessage,
  type HostPart,
  type PanelPublic,
  type Participant,
  type PlayFrame,
  type PlayMode,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionFrame,
  type SessionInfo,
  type WorkspacePreview,
  type WorkspaceRole,
} from "@tukurium/shared";
import * as Y from "yjs";
import type { RepoService } from "./repos/service";
import type { Store, User, WorkspaceMeta } from "./store/store";
import { canRead, canWrite, DocRoom } from "./workspaces/docRoom";

export interface Peer {
  send(data: string): void;
  close(): void;
}

export interface HubOptions {
  /** 持ち主が切断してからセッションを閉じるまでの猶予（再接続を待つ） */
  ownerGraceMs?: number;
  /** 自動保存の間隔 */
  saveDelayMs?: number;
  log?: (msg: string) => void;
  /** リポジトリ（ワークスペースの元）。テストでは省略できる */
  repos?: RepoService;
}

interface Conn {
  id: string;
  peer: Peer;
  user: User | null;
  session: Session | null;
  pose: Omit<Participant, "id" | "name">;
  open: Set<string>;
  panels: PanelPublic[];
}

interface Placement {
  id: string;
  /** ワークスペースから出した配置。作品のリリースから置いたものは null */
  workspaceId: string | null;
  releaseId: string | null;
  /** リリースから置いた配置の制作データと表示名 */
  snapshot?: unknown;
  label?: string;
  outputId: string;
  position: [number, number, number];
  yaw: number;
  placedBy: string;
}

interface Session {
  id: string;
  name: string;
  owner: string;
  conns: Set<Conn>;
  workspaces: Set<string>;
  closeTimer: ReturnType<typeof setTimeout> | null;
  /** 配置された実体の台帳 */
  placements: Map<string, Placement>;
  /** ワークスペース・アウトプットごとの、最後に出した（適用した）制作データ */
  builds: Map<string, unknown>;
  /** セッションの世界を実行する接続（持ち主） */
  host: Conn | null;
  lastFrame: SessionFrame | null;
}

const buildKey = (workspaceId: string, outputId: string) => `${workspaceId}\u0000${outputId}`;

/** 制作データが最低限の形をしているか（中身はホストのサンドボックスで実行される） */
function looksLikeSnapshot(v: unknown, outputId: string): boolean {
  if (!v || typeof v !== "object") return false;
  const o = (v as { outputs?: unknown }).outputs;
  return Array.isArray(o) && o.some((x) => (x as { id?: unknown })?.id === outputId);
}

interface Workspace {
  meta: WorkspaceMeta;
  session: Session;
  room: DocRoom;
  /** ワークスペースを開いている接続 */
  conns: Set<Conn>;
  /** 再生の実行を確定する接続 */
  host: Conn | null;
  mode: PlayMode;
  lastFrame: PlayFrame | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  /** 開いていない参加者に見せる、編集中の見た目（ホストが送る） */
  lastPreview: WorkspacePreview | null;
}

const snapshotUsesAsset = (snap: unknown, assetId: string): boolean => {
  const assets = (snap as { assets?: unknown } | null)?.assets;
  return Array.isArray(assets) && assets.some((a) => (a as { id?: unknown })?.id === assetId);
};

const shortId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const toB64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/**
 * 接続・セッション・ワークスペースをまとめて扱う。
 * - セッションは開いたユーザーの持ち物。持ち主がいなくなる（猶予つき）か閉じると終わる。
 * - ワークスペースはセッションの中で開く。中身は権限付きで同期し（DocRoom）、自動保存する。
 * - ワークスペースの再生は、ホスト（管理権限を持つ人の接続）が実行し、状態を配信する。
 */
export class Hub {
  private readonly conns = new Map<string, Conn>();
  private readonly sessions = new Map<string, Session>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly opts: Required<Omit<HubOptions, "repos">>;
  private readonly repos: RepoService | null;

  constructor(
    private readonly store: Store,
    options: HubOptions = {},
  ) {
    const { repos, ...rest } = options;
    this.opts = { ownerGraceMs: 30_000, saveDelayMs: 1000, log: () => {}, ...rest };
    this.repos = repos ?? null;
  }

  get stats() {
    return {
      connections: this.conns.size,
      sessions: this.sessions.size,
      workspaces: this.workspaces.size,
    };
  }

  connect(peer: Peer): { onMessage(raw: string): void; onClose(): void } {
    const conn: Conn = {
      id: randomUUID(),
      peer,
      user: null,
      session: null,
      pose: { position: [0, 0, 0], yaw: 0, pitch: 0 },
      open: new Set(),
      panels: [],
    };
    this.conns.set(conn.id, conn);
    // メッセージは届いた順に処理する（Store の非同期処理をまたいでも順序を保つ）
    let queue = Promise.resolve();
    return {
      onMessage: (raw) => {
        queue = queue
          .then(() => this.handle(conn, raw))
          .catch((e) => this.opts.log(`hub error: ${e}`));
      },
      onClose: () => {
        queue = queue.then(() => this.disconnect(conn));
      },
    };
  }

  /** すべてのワークスペースを保存する（終了時） */
  async flush(): Promise<void> {
    await Promise.all([...this.workspaces.values()].map((w) => this.saveNow(w)));
  }

  // ---------------------------------------------------------------------------

  private async handle(conn: Conn, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = ClientMessage.parse(JSON.parse(raw));
    } catch {
      this.send(conn, { t: "error", message: "invalid message" });
      return;
    }
    if (msg.t === "hello") return this.hello(conn, msg);
    if (!conn.user) {
      this.send(conn, { t: "error", message: "hello が必要です" });
      return;
    }
    const user = conn.user;
    switch (msg.t) {
      case "rename":
        user.name = msg.name;
        await this.store.renameUser(user.id, msg.name);
        if (conn.session) this.broadcastSession(conn.session);
        return;
      case "sessions.list":
        return this.send(conn, { t: "sessions", sessions: this.sessionList() });
      case "session.create":
        return this.createSession(conn, msg.name);
      case "session.join":
        return this.joinSession(conn, msg.sessionId);
      case "session.leave":
        return this.leaveSession(conn);
      case "session.close":
        if (conn.session && conn.session.owner === user.id)
          await this.closeSession(conn.session, "持ち主がセッションを閉じました");
        return;
      case "pose":
        if (!conn.session) return;
        conn.pose = { position: msg.position, yaw: msg.yaw, pitch: msg.pitch };
        this.toSession(conn.session, { t: "pose", id: user.id, ...conn.pose }, conn);
        return;
      case "panels":
        conn.panels = msg.panels;
        if (conn.session)
          for (const other of conn.session.conns) if (other !== conn) this.sendPanels(conn, other);
        return;
      case "place":
        return this.place(conn, msg);
      case "ws.preview": {
        const w = this.workspaceFor(conn, msg.workspaceId);
        if (!w || w.host !== conn) return; // ホスト以外の見た目は受け付けない
        w.lastPreview = msg.preview;
        for (const c of w.session.conns) if (!w.conns.has(c)) this.sendPreview(w, c);
        return;
      }
      case "ws.openRepo":
        return this.openRepo(conn, msg.repoId);
      case "ws.commit":
        return this.commit(conn, msg.workspaceId, msg.message);
      case "placeRelease":
        return this.placeRelease(conn, msg);
      case "apply": {
        const s = conn.session;
        const w = this.workspaceFor(conn, msg.workspaceId);
        if (!s || !w || !canWrite(this.roleOf(w, user.id)))
          return this.deny(conn, "適用には共同編集の権限が必要です");
        if (!looksLikeSnapshot(msg.snapshot, msg.outputId))
          return this.deny(conn, "制作データが壊れています");
        if (w.meta.defaultRole === null) {
          return this.deny(conn, "非公開の作業はセッションに適用できません");
        }
        const links = [...s.placements.values()].filter(
          (p) => p.workspaceId === msg.workspaceId && p.outputId === msg.outputId,
        );
        if (links.length === 0)
          return this.deny(conn, "このアウトプットはセッションに出ていません");
        s.builds.set(buildKey(msg.workspaceId, msg.outputId), msg.snapshot);
        if (s.host) {
          this.send(s.host, {
            t: "host.apply",
            realm: msg.workspaceId,
            outputId: msg.outputId,
            snapshot: msg.snapshot,
            by: user.name,
          });
        }
        this.broadcastSession(s);
        return;
      }
      case "unplace":
      case "resetPart": {
        const s = conn.session;
        const p = s?.placements.get(msg.placementId);
        if (!s || !p) return;
        const w = p.workspaceId ? this.workspaces.get(p.workspaceId) : undefined;
        const allowed =
          s.owner === user.id || p.placedBy === user.id || (w && canWrite(this.roleOf(w, user.id)));
        if (!allowed) return this.deny(conn, "この配置を操作する権限がありません");
        if (msg.t === "unplace") {
          s.placements.delete(p.id);
          if (s.host) this.send(s.host, { t: "host.removePart", id: p.id });
          this.broadcastSession(s);
        } else if (s.host) {
          this.send(s.host, { t: "host.resetPart", id: p.id });
        }
        return;
      }
      case "session.input":
        if (conn.session?.host) this.send(conn.session.host, { t: "host.input", input: msg.input });
        return;
      case "session.frame": {
        const s = conn.session;
        if (!s || s.host !== conn) return; // ホスト以外の状態は受け付けない
        s.lastFrame = msg.frame;
        for (const c of s.conns)
          if (c !== conn) this.send(c, { t: "session.frame", frame: msg.frame });
        return;
      }
      case "session.log": {
        const s = conn.session;
        if (!s || s.host !== conn) return;
        for (const c of s.conns)
          if (c !== conn)
            this.send(c, { t: "session.log", message: msg.message, level: msg.level });
        return;
      }
      case "ws.create":
        return this.createWorkspace(conn, msg.name, msg.initial);
      case "ws.open":
        return this.openWorkspace(conn, msg.workspaceId);
      case "ws.close":
        return this.closeWorkspace(conn, msg.workspaceId);
      case "ws.update": {
        const w = this.workspaceFor(conn, msg.workspaceId);
        if (w && !w.room.receive(conn.id, fromB64(msg.update))) {
          this.send(conn, { t: "error", message: "このワークスペースを編集する権限がありません" });
        }
        return;
      }
      case "ws.awareness": {
        const w = this.workspaceFor(conn, msg.workspaceId);
        if (!w || !canRead(this.roleOf(w, user.id))) return;
        for (const other of w.conns) {
          if (other !== conn && canRead(this.roleOf(w, other.user?.id))) {
            this.send(other, { t: "ws.awareness", workspaceId: w.meta.id, update: msg.update });
          }
        }
        return;
      }
      case "ws.setRole":
        return this.setRole(conn, msg.workspaceId, msg.userId, msg.role);
      case "ws.setDefaultRole": {
        const w = this.workspaceFor(conn, msg.workspaceId);
        if (!w || this.roleOf(w, user.id) !== "admin") return this.deny(conn, "管理権限が必要です");
        w.meta.defaultRole = msg.role;
        await this.store.saveWorkspace(w.meta);
        this.sendPreviews(w.session);
        this.broadcastSession(w.session);
        return;
      }
      case "ws.cmd": {
        const w = this.workspaceFor(conn, msg.workspaceId);
        if (!w || !canWrite(this.roleOf(w, user.id)))
          return this.deny(conn, "再生の操作には共同編集の権限が必要です");
        if (!w.host) return this.deny(conn, "再生を実行できる人（管理権限を持つ人）がいません");
        this.send(w.host, {
          t: "ws.cmd",
          workspaceId: w.meta.id,
          cmd: msg.cmd,
          outputId: msg.outputId,
          from: user.id,
        });
        return;
      }
      case "ws.input": {
        const w = this.workspaceFor(conn, msg.workspaceId);
        if (!w?.host || !canRead(this.roleOf(w, user.id))) return;
        this.send(w.host, { t: "ws.input", workspaceId: w.meta.id, input: msg.input });
        return;
      }
      case "ws.frame": {
        const w = this.workspaceFor(conn, msg.workspaceId);
        if (!w || w.host !== conn) return; // ホスト以外の状態は受け付けない
        const changed = w.mode !== msg.frame.mode;
        w.mode = msg.frame.mode;
        w.lastFrame = msg.frame.mode === "edit" ? null : msg.frame;
        for (const other of w.conns) {
          if (other !== conn && canRead(this.roleOf(w, other.user?.id))) {
            this.send(other, { t: "ws.frame", workspaceId: w.meta.id, frame: msg.frame });
          }
        }
        if (changed) this.broadcastSession(w.session);
        return;
      }
      case "ws.log": {
        const w = this.workspaceFor(conn, msg.workspaceId);
        if (!w || w.host !== conn) return;
        for (const other of w.conns) {
          if (other !== conn && canRead(this.roleOf(w, other.user?.id))) {
            this.send(other, {
              t: "ws.log",
              workspaceId: w.meta.id,
              message: msg.message,
              level: msg.level,
            });
          }
        }
        return;
      }
    }
  }

  private async hello(conn: Conn, msg: Extract<ClientMessage, { t: "hello" }>): Promise<void> {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.send(conn, { t: "error", message: `protocol mismatch (server ${PROTOCOL_VERSION})` });
      conn.peer.close();
      return;
    }
    if (conn.user) return;
    let token = msg.token;
    let user = token ? await this.store.userByToken(token) : null;
    if (!user || !token) {
      const created = await this.store.createUser(msg.name);
      user = created.user;
      token = created.token;
    } else if (user.name !== msg.name) {
      user.name = msg.name;
      await this.store.renameUser(user.id, msg.name);
    }
    conn.user = user;
    this.send(conn, {
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      you: { id: user.id, name: user.name },
      token,
    });
    this.send(conn, { t: "sessions", sessions: this.sessionList() });
  }

  // ---------------------------------------------------------------------------
  // セッション

  private createSession(conn: Conn, name: string): void {
    if (!conn.user) return;
    this.leaveSession(conn);
    const s: Session = {
      id: shortId("s"),
      name,
      owner: conn.user.id,
      conns: new Set(),
      workspaces: new Set(),
      closeTimer: null,
      placements: new Map(),
      builds: new Map(),
      host: null,
      lastFrame: null,
    };
    this.sessions.set(s.id, s);
    this.opts.log(`session created ${s.id} by ${conn.user.id}`);
    this.joinSession(conn, s.id);
    this.broadcastSessionList();
  }

  private joinSession(conn: Conn, sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!conn.user) return;
    if (!s) {
      this.send(conn, {
        t: "session.closed",
        reason: "セッションが見つかりません（閉じられた可能性があります）",
      });
      return;
    }
    if (conn.session === s) return;
    this.leaveSession(conn);
    conn.session = s;
    conn.pose = {
      position: [(Math.random() - 0.5) * 6, 0, 6 + Math.random() * 2],
      yaw: 0,
      pitch: 0,
    };
    s.conns.add(conn);
    if (conn.user.id === s.owner && s.closeTimer) {
      clearTimeout(s.closeTimer);
      s.closeTimer = null;
    }
    this.toSession(s, { t: "joined", participant: this.participant(conn) }, conn);
    if (!s.host && conn.user.id === s.owner) this.setSessionHost(s, conn);
    this.broadcastSession(s);
    for (const other of s.conns) {
      if (other === conn) continue;
      this.sendPanels(other, conn);
      this.sendPanels(conn, other);
    }
    this.sendPreviews(s, conn);
    this.broadcastSessionList();
  }

  private leaveSession(conn: Conn): void {
    const s = conn.session;
    if (!s || !conn.user) return;
    for (const wid of [...conn.open]) this.closeWorkspace(conn, wid);
    s.conns.delete(conn);
    conn.session = null;
    conn.panels = [];
    if (s.host === conn) {
      s.host = null;
      // 持ち主の別の接続（別のタブなど）があれば引き継ぐ。いなければ世界は止まり、戻ったら続きから
      const next = [...s.conns].find((c) => c.user?.id === s.owner);
      if (next) this.setSessionHost(s, next);
    }
    const stillHere = [...s.conns].some((c) => c.user?.id === conn.user?.id);
    if (!stillHere) this.toSession(s, { t: "left", id: conn.user.id });
    this.broadcastSession(s);
    // 持ち主がいなくなったら、猶予のあとセッションを閉じる
    if (conn.user.id === s.owner && !stillHere && !s.closeTimer) {
      s.closeTimer = setTimeout(() => {
        void this.closeSession(s, "持ち主が退出したため、セッションを閉じました");
      }, this.opts.ownerGraceMs);
    }
    this.broadcastSessionList();
  }

  private async closeSession(s: Session, reason: string): Promise<void> {
    if (!this.sessions.has(s.id)) return;
    this.sessions.delete(s.id);
    if (s.closeTimer) clearTimeout(s.closeTimer);
    for (const wid of s.workspaces) {
      const w = this.workspaces.get(wid);
      if (!w) continue;
      await this.saveNow(w);
      this.workspaces.delete(wid);
    }
    for (const c of s.conns) {
      c.session = null;
      c.open.clear();
      c.panels = [];
      this.send(c, { t: "session.closed", reason });
    }
    s.conns.clear();
    this.opts.log(`session closed ${s.id}: ${reason}`);
    this.broadcastSessionList();
  }

  private sessionList() {
    return [...this.sessions.values()].map((s) => {
      const ownerConn = [...s.conns].find((c) => c.user?.id === s.owner);
      return {
        id: s.id,
        name: s.name,
        owner: { id: s.owner, name: ownerConn?.user?.name ?? "（退出中）" },
        count: new Set([...s.conns].map((c) => c.user?.id)).size,
      };
    });
  }

  private broadcastSessionList(): void {
    const msg: ServerMessage = { t: "sessions", sessions: this.sessionList() };
    for (const c of this.conns.values()) if (c.user && !c.session) this.send(c, msg);
  }

  private sessionInfo(s: Session): SessionInfo {
    const users = new Map<string, User>();
    for (const c of s.conns) if (c.user) users.set(c.user.id, c.user);
    return {
      id: s.id,
      name: s.name,
      owner: s.owner,
      host: s.host?.user?.id ?? null,
      placements: [...s.placements.values()].map((p) => {
        const snap = (
          p.workspaceId ? s.builds.get(buildKey(p.workspaceId, p.outputId)) : p.snapshot
        ) as { outputs?: { id: string; name: string }[] } | undefined;
        return {
          id: p.id,
          workspaceId: p.workspaceId,
          releaseId: p.releaseId,
          position: p.position,
          yaw: p.yaw,
          placedBy: p.placedBy,
          outputId: p.outputId,
          workspaceName: p.workspaceId
            ? (this.workspaces.get(p.workspaceId)?.meta.name ?? "（閉じたワークスペース）")
            : (p.label ?? "作品"),
          outputName: snap?.outputs?.find((o) => o.id === p.outputId)?.name ?? p.outputId,
        };
      }),
      participants: [...users.values()].map((u) => ({ id: u.id, name: u.name })),
      workspaces: [...s.workspaces].flatMap((wid) => {
        const w = this.workspaces.get(wid);
        if (!w) return [];
        return [
          {
            id: w.meta.id,
            name: w.meta.name,
            repoId: w.meta.repoId ?? null,
            host: w.host?.user?.id ?? null,
            defaultRole: w.meta.defaultRole,
            members: Object.entries(w.meta.members).map(([userId, role]) => ({ userId, role })),
            present: [...new Set([...w.conns].flatMap((c) => (c.user ? [c.user.id] : [])))],
            mode: w.mode,
          },
        ];
      }),
    };
  }

  private broadcastSession(s: Session): void {
    const info = this.sessionInfo(s);
    const participants = this.participants(s);
    for (const c of s.conns) this.send(c, { t: "session", session: info, participants });
  }

  private participants(s: Session): Participant[] {
    const seen = new Map<string, Participant>();
    for (const c of s.conns)
      if (c.user && !seen.has(c.user.id)) seen.set(c.user.id, this.participant(c));
    return [...seen.values()];
  }

  private participant(c: Conn): Participant {
    return { id: c.user?.id ?? c.id, name: c.user?.name ?? "?", ...c.pose };
  }

  // ---------------------------------------------------------------------------
  // セッションの世界（配置された実体）

  private place(conn: Conn, msg: Extract<ClientMessage, { t: "place" }>): void {
    const s = conn.session;
    const user = conn.user;
    const w = this.workspaceFor(conn, msg.workspaceId);
    if (!s || !user || !w || !canWrite(this.roleOf(w, user.id))) {
      this.deny(conn, "セッションに出すには共同編集の権限が必要です");
      return;
    }
    if (!looksLikeSnapshot(msg.snapshot, msg.outputId)) {
      this.deny(conn, "制作データが壊れています");
      return;
    }
    if (w.meta.defaultRole === null) {
      this.deny(conn, "非公開の作業はセッションに出せません（独立した空間で表示・実行します）");
      return;
    }
    s.builds.set(buildKey(msg.workspaceId, msg.outputId), msg.snapshot);
    const p: Placement = {
      id: shortId("pl"),
      workspaceId: msg.workspaceId,
      releaseId: null,
      outputId: msg.outputId,
      position: msg.position,
      yaw: msg.yaw,
      placedBy: user.id,
    };
    s.placements.set(p.id, p);
    if (s.host) this.send(s.host, { t: "host.addPart", part: this.hostPart(s, p) });
    this.broadcastSession(s);
  }

  private hostPart(s: Session, p: Placement): HostPart {
    return {
      id: p.id,
      // リリースから置いたものは、ワークスペースとは別の領域（KokoState の名前の範囲）にする
      realm: p.workspaceId ?? `rel_${p.releaseId}`,
      outputId: p.outputId,
      snapshot: p.workspaceId ? s.builds.get(buildKey(p.workspaceId, p.outputId)) : p.snapshot,
      position: p.position,
      yaw: p.yaw,
    };
  }

  private setSessionHost(s: Session, conn: Conn): void {
    s.host = conn;
    const parts = [...s.placements.values()].map((p) => this.hostPart(s, p));
    this.send(conn, { t: "session.host", parts, resume: s.lastFrame });
  }

  // ---------------------------------------------------------------------------
  // ワークスペース

  private async createWorkspace(conn: Conn, name: string, initial: string): Promise<void> {
    if (!conn.user || !conn.session) return this.deny(conn, "セッションに参加していません");
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, fromB64(initial));
    } catch {
      return this.deny(conn, "初期内容が壊れています");
    }
    // ワークスペースは必ずリポジトリを持つ（作るとリポジトリと最初のコミットができる）
    let repoId: string | undefined;
    if (this.repos) {
      const repo = await this.repos.create(conn.user, {
        name,
        snapshot: new ProjectDoc(doc).snapshot(),
      });
      repoId = repo.id;
    }
    const meta: WorkspaceMeta = {
      id: repoId ? `w_${repoId}` : shortId("ws"),
      name,
      repoId,
      createdBy: conn.user.id,
      defaultRole: "editor",
      members: { [conn.user.id]: "admin" },
    };
    await this.store.saveWorkspace(meta);
    await this.store.saveDoc(meta.id, Y.encodeStateAsUpdate(doc));
    this.send(conn, { t: "ws.created", workspaceId: meta.id });
    await this.load(meta, conn.session, doc);
    await this.openWorkspace(conn, meta.id);
  }

  /** リポジトリを開く。同じリポジトリのワークスペースは同時に 1 つだけ（別のセッションで開かれていたら断る） */
  private async openRepo(conn: Conn, repoId: string): Promise<void> {
    const s = conn.session;
    const user = conn.user;
    if (!s || !user || !this.repos) return this.deny(conn, "セッションに参加していません");
    let repo: Awaited<ReturnType<RepoService["readable"]>>;
    try {
      repo = await this.repos.readable(user, repoId);
    } catch {
      return this.deny(conn, "リポジトリが見つかりません");
    }
    const wid = `w_${repo.id}`;
    const loaded = this.workspaces.get(wid);
    if (loaded && loaded.session !== s) {
      return this.denyWs(
        conn,
        wid,
        "このリポジトリは別のセッションで開かれています（1 リポジトリにつき 1 ワークスペース）",
      );
    }
    if (!loaded) {
      const meta: WorkspaceMeta = (await this.store.workspace(wid)) ?? {
        id: wid,
        name: repo.name,
        repoId: repo.id,
        createdBy: repo.owner,
        defaultRole: "editor",
        members: { [repo.owner]: "admin" },
      };
      // 開いた人は、このワークスペースの再生を実行できる（管理）。コミットはリポジトリの持ち主だけ
      if (!meta.members[user.id]) meta.members[user.id] = "admin";
      meta.name = repo.name;
      await this.store.saveWorkspace(meta);
      let doc: Y.Doc | undefined;
      if (!(await this.store.loadDoc(wid))) {
        const pd = new ProjectDoc();
        pd.load(await this.repos.snapshot(repo.id));
        pd.setName(repo.name);
        doc = pd.doc;
      }
      await this.load(meta, s, doc);
    }
    this.send(conn, { t: "ws.created", workspaceId: wid });
    await this.openWorkspace(conn, wid);
  }

  /**
   * プロジェクト（リポジトリ）の名前が変わった：開いているワークスペースの名前と、
   * 制作データの名前（次のコミットに入る）を揃え、参加者に知らせる。
   */
  async renameRepo(repoId: string, name: string): Promise<void> {
    for (const w of this.workspaces.values()) {
      if (w.meta.repoId !== repoId) continue;
      w.meta.name = name;
      await this.store.saveWorkspace(w.meta);
      const pd = new ProjectDoc(w.room.doc);
      pd.transact(() => pd.setName(name), "server");
      this.scheduleSave(w);
      this.broadcastSession(w.session);
    }
  }

  /** コミット：いまの制作データを、メッセージ付きで履歴に保存する。一緒に編集した人は Co-author */
  private async commit(conn: Conn, workspaceId: string, message: string): Promise<void> {
    const w = this.workspaceFor(conn, workspaceId);
    const user = conn.user;
    if (!w || !user || !this.repos || !w.meta.repoId) return this.deny(conn, "コミットできません");
    const repo = await this.repos.require(w.meta.repoId);
    if (repo.owner !== user.id) return this.deny(conn, "コミットできるのはリポジトリの持ち主です");
    const coAuthors = new Map<string, User>();
    for (const c of w.conns) {
      if (c.user && c.user.id !== user.id && canWrite(this.roleOf(w, c.user.id))) {
        coAuthors.set(c.user.id, c.user);
      }
    }
    const snap = new ProjectDoc(w.room.doc).snapshot();
    const oid = await this.repos.commit(repo.id, { ...snap, name: repo.name }, message, user, [
      ...coAuthors.values(),
    ]);
    await this.saveNow(w);
    for (const c of w.conns) {
      this.send(c, {
        t: "ws.committed",
        workspaceId,
        commit: oid,
        message: message || "（メッセージなし）",
        by: user.name,
      });
    }
  }

  /** 作品のリリースをセッションに置く（作品の「利用」権限、または持ち主） */
  private async placeRelease(
    conn: Conn,
    msg: Extract<ClientMessage, { t: "placeRelease" }>,
  ): Promise<void> {
    const s = conn.session;
    const user = conn.user;
    if (!s || !user || !this.repos) return;
    const release = await this.store.release(msg.releaseId);
    const work = release ? await this.store.work(release.workId) : null;
    if (!release || !work) return this.deny(conn, "リリースが見つかりません");
    if (!work.perms.use && work.owner !== user.id) {
      return this.deny(conn, "この作品を利用する権限がありません");
    }
    const snapshot = await this.repos.snapshot(work.repoId, release.commit);
    const p: Placement = {
      id: shortId("pl"),
      workspaceId: null,
      releaseId: release.id,
      snapshot,
      label: `${work.name} v${release.version}`,
      outputId: work.outputId,
      position: msg.position,
      yaw: msg.yaw,
      placedBy: user.id,
    };
    s.placements.set(p.id, p);
    if (s.host) this.send(s.host, { t: "host.addPart", part: this.hostPart(s, p) });
    this.broadcastSession(s);
  }

  private async load(meta: WorkspaceMeta, session: Session, doc?: Y.Doc): Promise<Workspace> {
    const existing = this.workspaces.get(meta.id);
    if (existing) return existing;
    const w: Workspace = {
      meta,
      session,
      room: new DocRoom((peerId) => {
        const c = this.conns.get(peerId);
        return c?.user ? this.roleOf(w, c.user.id) : null;
      }),
      conns: new Set(),
      host: null,
      mode: "edit",
      lastFrame: null,
      saveTimer: null,
      lastPreview: null,
    };
    if (doc) {
      Y.applyUpdate(w.room.doc, Y.encodeStateAsUpdate(doc));
    } else {
      const saved = await this.store.loadDoc(meta.id);
      if (saved) Y.applyUpdate(w.room.doc, saved);
    }
    w.room.doc.on("update", () => this.scheduleSave(w));
    this.workspaces.set(meta.id, w);
    session.workspaces.add(meta.id);
    return w;
  }

  private async openWorkspace(conn: Conn, workspaceId: string): Promise<void> {
    const s = conn.session;
    if (!conn.user || !s) return;
    let w = this.workspaces.get(workspaceId);
    if (!w) {
      // このセッションで開いたことがあるワークスペースだけ開ける（M4 でリポジトリから開けるようにする）
      return this.denyWs(conn, workspaceId, "このセッションのワークスペースではありません");
    }
    if (w.session !== s)
      return this.denyWs(conn, workspaceId, "このセッションのワークスペースではありません");
    let role = this.roleOf(w, conn.user.id);
    if (!role) return this.denyWs(conn, workspaceId, "このワークスペースは非公開です");
    if (!w.meta.members[conn.user.id]) {
      // 既定の権限で参加したことを記録する（管理者があとから変えられる）
      w.meta.members[conn.user.id] = role;
      await this.store.saveWorkspace(w.meta);
      role = w.meta.members[conn.user.id] as WorkspaceRole;
    }
    w = this.workspaces.get(workspaceId) as Workspace;
    if (conn.open.has(workspaceId)) return;
    conn.open.add(workspaceId);
    w.conns.add(conn);
    const joined = w.room.join(
      {
        id: conn.id,
        sendUpdate: (u) => this.send(conn, { t: "ws.update", workspaceId, update: toB64(u) }),
      },
      false,
    );
    if (!joined) return;
    // 全体は権限と一緒に送る
    this.send(conn, {
      t: "ws.doc",
      workspaceId,
      update: toB64(Y.encodeStateAsUpdate(w.room.doc)),
      role,
    });
    if (!w.host && role === "admin") this.setHost(w, conn);
    else if (w.lastFrame) this.send(conn, { t: "ws.frame", workspaceId, frame: w.lastFrame });
    this.broadcastSession(s);
  }

  private closeWorkspace(conn: Conn, workspaceId: string): void {
    const w = this.workspaces.get(workspaceId);
    conn.open.delete(workspaceId);
    if (!w) return;
    w.conns.delete(conn);
    w.room.leave(conn.id);
    if (w.host === conn) this.migrateHost(w);
    this.sendPreview(w, conn);
    this.broadcastSession(w.session);
  }

  private setHost(w: Workspace, conn: Conn): void {
    w.host = conn;
    this.send(conn, { t: "ws.host", workspaceId: w.meta.id, resume: w.lastFrame });
    this.opts.log(`host of ${w.meta.id} -> ${conn.user?.id}`);
  }

  /** ホストが抜けたら、ワークスペースを開いている管理者に引き継ぐ。いなければ再生を止める。 */
  private migrateHost(w: Workspace): void {
    w.host = null;
    const next = [...w.conns].find((c) => c.user && this.roleOf(w, c.user.id) === "admin");
    if (next) {
      this.setHost(w, next);
      return;
    }
    if (w.mode !== "edit") {
      w.mode = "edit";
      w.lastFrame = null;
      const frame: PlayFrame = {
        mode: "edit",
        outputId: "",
        time: 0,
        world: null,
        names: {},
        status: [],
      };
      for (const c of w.conns) this.send(c, { t: "ws.frame", workspaceId: w.meta.id, frame });
      for (const c of w.conns) {
        this.send(c, {
          t: "ws.log",
          workspaceId: w.meta.id,
          message: "ホストを引き継げる人（管理権限）がいないため、再生を止めました",
          level: "error",
        });
      }
    }
  }

  private async setRole(
    conn: Conn,
    workspaceId: string,
    userId: string,
    role: WorkspaceRole | null,
  ): Promise<void> {
    const w = this.workspaceFor(conn, workspaceId);
    if (!w || !conn.user || this.roleOf(w, conn.user.id) !== "admin")
      return this.deny(conn, "管理権限が必要です");
    const admins = Object.entries(w.meta.members).filter(([, r]) => r === "admin");
    if (w.meta.members[userId] === "admin" && role !== "admin" && admins.length <= 1) {
      return this.deny(conn, "管理者が 1 人もいなくなるため変更できません");
    }
    if (role) w.meta.members[userId] = role;
    else delete w.meta.members[userId];
    await this.store.saveWorkspace(w.meta);
    // 閲覧できなくなった接続を外す
    const removed = new Set(w.room.revalidate());
    for (const c of [...w.conns]) {
      if (c.user?.id !== userId) continue;
      const r = this.roleOf(w, userId);
      this.send(c, { t: "ws.role", workspaceId, role: r });
      if (removed.has(c.id)) {
        c.open.delete(workspaceId);
        w.conns.delete(c);
        if (w.host === c) this.migrateHost(w);
      } else if (w.host === c && r !== "admin") {
        this.migrateHost(w);
      } else if (!w.host && r === "admin") {
        this.setHost(w, c);
      }
    }
    this.sendPreviews(w.session);
    // 権限が変わったので、その人に見せるパネルの内容も変わる
    for (const other of w.session.conns) {
      if (other.user?.id === userId)
        for (const src of w.session.conns) if (src !== other) this.sendPanels(src, other);
    }
    this.broadcastSession(w.session);
  }

  private roleOf(w: Workspace, userId: string | undefined): WorkspaceRole | null {
    if (!userId) return null;
    return w.meta.members[userId] ?? w.meta.defaultRole;
  }

  private workspaceFor(conn: Conn, workspaceId: string): Workspace | null {
    const w = this.workspaces.get(workspaceId);
    return w && conn.open.has(workspaceId) ? w : null;
  }

  private scheduleSave(w: Workspace): void {
    if (w.saveTimer) return;
    w.saveTimer = setTimeout(() => {
      w.saveTimer = null;
      void this.saveNow(w);
    }, this.opts.saveDelayMs);
  }

  private async saveNow(w: Workspace): Promise<void> {
    if (w.saveTimer) {
      clearTimeout(w.saveTimer);
      w.saveTimer = null;
    }
    await this.store.saveDoc(w.meta.id, Y.encodeStateAsUpdate(w.room.doc));
  }

  /** 開いていない人に、編集中の見た目を権限に合わせて送る（閲覧できなければ境界だけ） */
  private sendPreview(w: Workspace, to: Conn): void {
    if (!w.lastPreview || !to.user || w.conns.has(to)) return;
    const restricted = !canRead(this.roleOf(w, to.user.id));
    this.send(to, {
      t: "ws.preview",
      workspaceId: w.meta.id,
      name: restricted ? "作業中" : w.meta.name,
      restricted,
      preview: restricted ? { ...w.lastPreview, world: null, materials: [] } : w.lastPreview,
    });
  }

  private sendPreviews(s: Session, to?: Conn): void {
    for (const wid of s.workspaces) {
      const w = this.workspaces.get(wid);
      if (!w) continue;
      for (const c of to ? [to] : s.conns) this.sendPreview(w, c);
    }
  }

  /** 素材を見てよいか（すぐ分かる範囲）：参加中のセッションに置かれた物か、閲覧できるワークスペースで使われている */
  canSeeAssetLive(user: User, assetId: string): boolean {
    const uses = (snap: unknown) => snapshotUsesAsset(snap, assetId);
    // 参加しているセッションに置かれている物の素材（作品のリリースを含む）
    for (const s of this.sessions.values()) {
      if (![...s.conns].some((c) => c.user?.id === user.id)) continue;
      for (const p of s.placements.values()) if (uses(this.hostPart(s, p).snapshot)) return true;
    }
    for (const w of this.workspaces.values()) {
      if (!canRead(this.roleOf(w, user.id))) continue;
      if (new ProjectDoc(w.room.doc).assets().some((a) => a.id === assetId)) return true;
    }
    return false;
  }

  /** 素材を見てよいか（重い）：閲覧できるリポジトリの最新の内容で使われている */
  async canSeeAssetInRepos(user: User, assetId: string): Promise<boolean> {
    if (!this.repos) return false;
    for (const r of await this.store.repos()) {
      if (!(await this.repos.canRead(user, r))) continue;
      const snap = await this.repos.snapshot(r.id).catch(() => null);
      if (snapshotUsesAsset(snap, assetId)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // パネル（他の人からの見え方）

  /** from が開いているパネルを、to の権限に合わせて送る */
  private sendPanels(from: Conn, to: Conn): void {
    if (!from.user || !to.user) return;
    const panels = from.panels.map((p) => {
      if (!p.workspaceId) return { ...p, restricted: false };
      const w = this.workspaces.get(p.workspaceId);
      const visible = w ? canRead(this.roleOf(w, to.user?.id)) : false;
      return visible
        ? { ...p, restricted: false }
        : { ...p, title: "作業中", lines: [], restricted: true };
    });
    this.send(to, { t: "panels", userId: from.user.id, panels });
  }

  // ---------------------------------------------------------------------------

  private async disconnect(conn: Conn): Promise<void> {
    this.leaveSession(conn);
    this.conns.delete(conn.id);
  }

  private toSession(s: Session, msg: ServerMessage, except?: Conn): void {
    const data = JSON.stringify(msg);
    for (const c of s.conns) if (c !== except) c.peer.send(data);
  }

  private send(conn: Conn, msg: ServerMessage): void {
    conn.peer.send(JSON.stringify(msg));
  }

  private deny(conn: Conn, message: string): void {
    this.send(conn, { t: "error", message });
  }

  private denyWs(conn: Conn, workspaceId: string, reason: string): void {
    this.send(conn, { t: "ws.denied", workspaceId, reason });
  }
}
