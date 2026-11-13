import { randomUUID } from "node:crypto";
import { parseValue, stringifyValue } from "@tukurium/eks";
import { type PackageResolution, ProjectDoc, type ProjectSnapshot } from "@tukurium/repo-model";
import {
  ClientMessage,
  type HostPart,
  type PanelPublic,
  type Participant,
  type PlayFrame,
  type PlayMode,
  PREVIEW_SHOT_HEIGHT,
  PREVIEW_SHOT_WIDTH,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionFrame,
  type SessionInfo,
  type WorkspacePreview,
  type WorkspaceRole,
} from "@tukurium/shared";
import * as Y from "yjs";
import { ItemCatalog } from "./repos/catalog";
import type { RepoService } from "./repos/service";
import { type Store, type User, userInfo, type WorkspaceMeta } from "./store/store";
import { fieldSchemasOf, packagesByAlias } from "./typecheck";
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
  /** ルートワールドを入れ替える前のカウントダウン（ADR 0066）。テストでは短くする */
  worldChangeMs?: number;
  log?: (msg: string) => void;
  /** リポジトリ（ワークスペースの元）。テストでは省略できる */
  repos?: RepoService;
}

interface Conn {
  id: string;
  peer: Peer;
  user: User | null;
  /** ログインのセッションのキー。ログアウトしたら、そのセッションの接続を閉じる（ADR 0074） */
  sessionKey?: string;
  /**
   * つないだ時点のログインの本人。hello を受けたら user に入れる
   * （それまでは一斉の知らせを送らない。welcome より先に届かないように）
   */
  login?: User;
  session: Session | null;
  pose: Omit<Participant, "id" | "name">;
  open: Set<string>;
  panels: PanelPublic[];
  /**
   * AI エージェントの接続（ADR 0054）。人と同じ道を通るが、ワークスペースのホスト（再生の実行役）
   * にはならず、保存（コミット）もできない。
   */
  agent?: boolean;
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
  /** 置いた物への付与（null は宣言どおり。ADR 0012） */
  grants: string[] | null;
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
  /** ルートワールドの入れ替え予定。数え終わると installWorld する */
  worldChange: {
    id: string;
    releaseId: string;
    worldName: string;
    byName: string;
    /** 入れ替える時刻（Date.now()） */
    at: number;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  placementRequests: Map<
    string,
    {
      fingerprint: string;
      result: Promise<Extract<ServerMessage, { t: "placement.result" }>>;
      until: number;
    }
  >;
}

const buildKey = (workspaceId: string, outputId: string) => `${workspaceId}\u0000${outputId}`;

/** 制作データが最低限の形をしているか（中身はホストのサンドボックスで実行される） */
function looksLikeSnapshot(v: unknown, outputId: string): boolean {
  if (!v || typeof v !== "object") return false;
  const o = (v as { outputs?: unknown }).outputs;
  return Array.isArray(o) && o.some((x) => (x as { id?: unknown })?.id === outputId);
}

/** セッションに置けるリリース（作品と、その時点の制作データ） */
interface LoadedRelease {
  release: { id: string; version: number };
  work: { id: string; name: string; owner: string; outputId: string; perms: { use: boolean } };
  snapshot: { outputs: { id: string; name?: string; kind?: string }[] };
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
  /** 保存の書き込みを順番に行う */
  saveTail?: Promise<void>;
  /** 閉じたあと。以降の保存と更新は受け付けない */
  ended: boolean;
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
  private readonly catalog: ItemCatalog | null;
  /**
   * 制作データ（オブジェクト）→ その依存の中身。ホストへ配置を渡すときに添える（ADR 0015）。
   * 制作データを捨てれば一緒に消える
   */
  private readonly packages = new WeakMap<object, PackageResolution[]>();
  /** 制作データ → フィールドのスキーマ（出した人の画面が作ったものか、リリースのためにサーバーが作ったもの。ADR 0065） */
  private readonly schemas = new WeakMap<object, unknown>();
  /** リリース → フィールドのスキーマ（リリースの中身は変わらないので、一度作れば使い回せる） */
  private readonly releaseSchemas = new Map<string, unknown>();
  /** 適用の通し番号（依存の取り出しを待つ間に、次の適用が来たら古い方を捨てる） */
  private readonly applySeq = new Map<string, number>();
  /** 開いている画面への撮影（ADR 0059）。requestId → 待っている約束 */
  private readonly shots = new Map<
    string,
    {
      conn: Conn;
      timer: ReturnType<typeof setTimeout>;
      resolve: (shot: { png: string; pending: boolean }) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly store: Store,
    options: HubOptions = {},
  ) {
    const { repos, ...rest } = options;
    this.opts = {
      ownerGraceMs: 30_000,
      saveDelayMs: 1000,
      worldChangeMs: 3_000,
      log: () => {},
      ...rest,
    };
    this.repos = repos ?? null;
    this.catalog = repos ? new ItemCatalog(store, repos) : null;
  }

  get stats() {
    return {
      connections: this.conns.size,
      sessions: this.sessions.size,
      workspaces: this.workspaces.size,
    };
  }

  presence(userId: string) {
    return {
      online: [...this.conns.values()].some((c) => c.user?.id === userId),
      sessions: this.sessionList().filter((s) => s.participants.some((p) => p.id === userId)),
    };
  }

  sessionSummary(sessionId: string) {
    return this.sessionList().find((s) => s.id === sessionId) ?? null;
  }

  notifyUsers(userIds: readonly string[]): void {
    const ids = new Set(userIds);
    for (const conn of this.conns.values())
      if (conn.user && ids.has(conn.user.id)) this.send(conn, { t: "social.changed" });
  }

  notifySocial(userId: string): void {
    void this.store
      .friendships(userId)
      .then((links) =>
        this.notifyUsers([
          userId,
          ...links
            .filter((f) => f.status === "accepted")
            .map((f) => (f.from === userId ? f.to : f.from)),
        ]),
      )
      .catch((e) => this.opts.log(`social update: ${e}`));
  }

  /**
   * 接続を受ける。人の接続は、つなぐ時点でログインの本人（user）を渡す（ADR 0074）。
   * 本人の無い接続は hello で断る。エージェントの内部の接続は hello の名前で利用者を作る
   */
  connect(
    peer: Peer,
    options: { agent?: boolean; user?: User; sessionKey?: string } = {},
  ): { onMessage(raw: string): void; onClose(): void } {
    const conn: Conn = {
      id: randomUUID(),
      peer,
      user: null,
      ...(options.user ? { login: { ...options.user } } : {}),
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      session: null,
      pose: { position: [0, 0, 0], yaw: 0, pitch: 0 },
      open: new Set(),
      panels: [],
      ...(options.agent ? { agent: true } : {}),
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

  /** ログアウトしたセッションの接続を閉じる（ほかのタブで開いていたものも） */
  endAuthSession(sessionKey: string): void {
    for (const c of this.conns.values()) {
      if (c.sessionKey !== sessionKey) continue;
      this.send(c, { t: "auth.required" });
      c.peer.close();
    }
  }

  /** すべてのワークスペースを保存する（終了時） */
  async flush(): Promise<void> {
    await Promise.all([...this.workspaces.values()].map((w) => this.saveNow(w)));
  }

  // ---------------------------------------------------------------------------

  private async handle(conn: Conn, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      // メッセージはタグ付きの JSON（ADR 0065）。形式に合わないものは、ここで弾かれる
      msg = ClientMessage.parse(parseValue(raw));
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
        this.broadcastSessionList();
        this.notifySocial(user.id);
        return;
      case "sessions.list":
        return this.send(conn, { t: "sessions", sessions: this.sessionList() });
      case "session.create":
        return this.createSession(conn, msg.name, msg.requestId, msg.worldReleaseId);
      case "session.join":
        return this.joinSession(conn, msg.sessionId, msg.requestId);
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
        // 保存は人だけ（ADR 0054。のちに権限の設定で変えられるようにする）
        if (conn.agent) return this.deny(conn, "エージェントは保存できません。保存は人が行います");
        return this.commit(conn, msg.workspaceId, msg.message);
      case "placeRelease":
        return this.placeRelease(conn, msg);
      case "session.openWorld":
        return this.openWorld(conn, msg.releaseId);
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
        const key = buildKey(msg.workspaceId, msg.outputId);
        const seq = (this.applySeq.get(key) ?? 0) + 1;
        this.applySeq.set(key, seq);
        if (hasDependencies(msg.snapshot))
          await this.attachPackages(msg.snapshot, await this.workspaceOwner(w));
        if (this.applySeq.get(key) !== seq) return;
        s.builds.set(key, msg.snapshot);
        this.rememberSchemas(msg.snapshot, msg.schemas);
        if (s.host) {
          const packages = this.packagesOf(msg.snapshot);
          this.send(s.host, {
            t: "host.apply",
            realm: msg.workspaceId,
            outputId: msg.outputId,
            snapshot: msg.snapshot,
            ...(packages ? { packages } : {}),
            ...(msg.schemas !== undefined ? { schemas: msg.schemas } : {}),
            by: user.name,
          });
        }
        this.broadcastSession(s);
        return;
      }
      case "setGrants": {
        const s = conn.session;
        const p = s?.placements.get(msg.placementId);
        if (!s || !p) return;
        const w = p.workspaceId ? this.workspaces.get(p.workspaceId) : undefined;
        const allowed =
          s.owner === user.id || p.placedBy === user.id || (w && canWrite(this.roleOf(w, user.id)));
        if (!allowed) return this.deny(conn, "この配置の権限を変える権限がありません");
        p.grants = msg.grants ? [...new Set(msg.grants)].sort() : null;
        if (s.host) this.send(s.host, { t: "host.setGrants", id: p.id, grants: p.grants });
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
        // プレイヤー ID は自己申告を使わず、接続の本人にする（バッグの持ち主の元。ADR 0018）
        if (conn.session?.host)
          this.send(conn.session.host, {
            t: "host.input",
            input: { ...msg.input, player: user.id },
          });
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
      case "ws.end":
        return this.endWorkspace(conn, msg.workspaceId);
      case "ws.update": {
        const w = this.workspaceFor(conn, msg.workspaceId);
        if (w?.ended) return;
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
        this.send(w.host, {
          t: "ws.input",
          workspaceId: w.meta.id,
          input: { ...msg.input, player: user.id },
        });
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
      case "ws.shot":
        return this.receiveShot(conn, msg);
    }
  }

  /**
   * ワークスペースを開いている一人の画面に、制作データの座標で撮影を頼む。
   * 再生中はそのホスト、編集中は開いている人の先頭。エージェントには頼まない。
   */
  requestCapture(
    workspaceId: string,
    pose: {
      position: [number, number, number];
      target: [number, number, number];
      fov?: number;
    },
  ): Promise<{
    png: string;
    pending: boolean;
    mode: PlayMode;
    width: number;
    height: number;
  }> {
    const w = this.workspaces.get(workspaceId);
    if (!w) return Promise.reject(new Error("ワークスペースが見つかりません"));
    const conn = this.captureConn(w);
    if (!conn)
      return Promise.reject(
        new Error(
          "ワークスペースを開いている人がいません。ブラウザでワークスペースを開いてから、もう一度 preview してください",
        ),
      );
    const requestId = shortId("cap");
    const shot = new Promise<{ png: string; pending: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.shots.delete(requestId);
        reject(new Error("ワークスペースを開いている人から、画面が返りませんでした"));
      }, 8_000);
      this.shots.set(requestId, { conn, timer, resolve, reject });
    });
    this.send(conn, {
      t: "ws.capture",
      workspaceId,
      requestId,
      position: pose.position,
      target: pose.target,
      ...(pose.fov !== undefined ? { fov: pose.fov } : {}),
    });
    return shot.then((got) => ({
      ...got,
      mode: w.mode,
      width: PREVIEW_SHOT_WIDTH,
      height: PREVIEW_SHOT_HEIGHT,
    }));
  }

  private captureConn(w: Workspace): Conn | null {
    const human = (c: Conn) => !c.agent && !!c.user && c.open.has(w.meta.id);
    if (w.mode !== "edit" && w.host && human(w.host)) return w.host;
    return [...w.conns].find(human) ?? null;
  }

  private receiveShot(conn: Conn, msg: Extract<ClientMessage, { t: "ws.shot" }>) {
    const pending = this.shots.get(msg.requestId);
    if (!pending || pending.conn !== conn) return;
    clearTimeout(pending.timer);
    this.shots.delete(msg.requestId);
    if (msg.error || !msg.png) pending.reject(new Error(msg.error ?? "画面を撮れませんでした"));
    else pending.resolve({ png: msg.png, pending: msg.pending === true });
  }

  private failShots(conn: Conn) {
    for (const [id, shot] of this.shots) {
      if (shot.conn !== conn) continue;
      clearTimeout(shot.timer);
      this.shots.delete(id);
      shot.reject(new Error("画面を撮る人の接続が切れました"));
    }
  }

  private async hello(conn: Conn, msg: Extract<ClientMessage, { t: "hello" }>): Promise<void> {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.send(conn, { t: "error", message: `protocol mismatch (server ${PROTOCOL_VERSION})` });
      conn.peer.close();
      return;
    }
    if (conn.user) return;
    const user =
      conn.login ?? (conn.agent && msg.name ? await this.store.createUser(msg.name) : null);
    if (!user) {
      this.send(conn, { t: "auth.required" });
      conn.peer.close();
      return;
    }
    conn.user = user;
    this.send(conn, { t: "welcome", protocol: PROTOCOL_VERSION, you: userInfo(user) });
    this.send(conn, { t: "sessions", sessions: this.sessionList() });
    this.notifySocial(user.id);
  }

  // ---------------------------------------------------------------------------
  // セッション

  private async createSession(
    conn: Conn,
    name: string,
    requestId?: string,
    worldReleaseId?: string,
  ): Promise<void> {
    if (!conn.user) return;
    // 開けないワールドではセッションを作らない（空の部屋が残らないように、先に確かめる）
    let loaded: LoadedRelease | null = null;
    if (worldReleaseId) {
      const ready = await this.loadUsableWorld(conn, worldReleaseId);
      if (!ready.ok) {
        this.send(conn, {
          t: "session.rejected",
          sessionId: worldReleaseId,
          requestId,
          message: ready.message,
        });
        return;
      }
      loaded = ready.loaded;
    }
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
      worldChange: null,
      placementRequests: new Map(),
    };
    this.sessions.set(s.id, s);
    if (loaded) this.installWorld(s, conn.user.id, loaded);
    this.opts.log(`session created ${s.id} by ${conn.user.id}`);
    this.joinSession(conn, s.id, requestId);
    this.broadcastSessionList();
  }

  private joinSession(conn: Conn, sessionId: string, requestId?: string): void {
    const s = this.sessions.get(sessionId);
    if (!conn.user) return;
    if (!s) {
      this.send(conn, {
        t: "session.rejected",
        sessionId,
        requestId,
        message: "セッションが見つかりません（閉じられたか、サーバーが更新された可能性があります）",
      });
      return;
    }
    this.send(conn, { t: "session.entered", sessionId, requestId });
    if (conn.session === s) {
      this.send(conn, {
        t: "session",
        session: this.sessionInfo(s),
        participants: this.participants(s),
      });
      return;
    }
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
    this.notifySocial(conn.user.id);
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
    this.notifySocial(conn.user.id);
  }

  private async closeSession(s: Session, reason: string): Promise<void> {
    if (!this.sessions.has(s.id)) return;
    this.clearWorldChange(s);
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
      if (c.user) this.notifySocial(c.user.id);
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
        owner: ownerConn?.user ? userInfo(ownerConn.user) : { id: s.owner, name: "（退出中）" },
        count: new Set([...s.conns].map((c) => c.user?.id)).size,
        participants: [
          ...new Map(
            [...s.conns].flatMap((c) => (c.user ? [[c.user.id, userInfo(c.user)] as const] : [])),
          ).values(),
        ],
      };
    });
  }

  private broadcastSessionList(): void {
    const msg: ServerMessage = { t: "sessions", sessions: this.sessionList() };
    for (const c of this.conns.values()) if (c.user) this.send(c, msg);
  }

  private sessionInfo(s: Session): SessionInfo {
    const users = new Map<string, User>();
    for (const c of s.conns) if (c.user) users.set(c.user.id, c.user);
    return {
      id: s.id,
      name: s.name,
      owner: s.owner,
      host: s.host?.user?.id ?? null,
      worldChange: s.worldChange
        ? {
            id: s.worldChange.id,
            releaseId: s.worldChange.releaseId,
            worldName: s.worldChange.worldName,
            byName: s.worldChange.byName,
            remainingMs: Math.min(60_000, Math.max(0, s.worldChange.at - Date.now())),
          }
        : null,
      placements: [...s.placements.values()].map((p) => {
        const snap = this.placementSnapshot(s, p);
        const output = snap?.outputs?.find((o) => o.id === p.outputId);
        return {
          id: p.id,
          workspaceId: p.workspaceId,
          releaseId: p.releaseId,
          position: p.position,
          yaw: p.yaw,
          placedBy: p.placedBy,
          grants: p.grants,
          outputId: p.outputId,
          workspaceName: p.workspaceId
            ? (this.workspaces.get(p.workspaceId)?.meta.name ?? "（閉じたワークスペース）")
            : (p.label ?? "作品"),
          outputName: output?.name ?? p.outputId,
          outputKind: this.placementKind(s, p),
        };
      }),
      participants: [...users.values()].map(userInfo),
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

  private async place(conn: Conn, msg: Extract<ClientMessage, { t: "place" }>): Promise<void> {
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
    if (hasDependencies(msg.snapshot))
      await this.attachPackages(msg.snapshot, await this.workspaceOwner(w));
    s.builds.set(buildKey(msg.workspaceId, msg.outputId), msg.snapshot);
    this.rememberSchemas(msg.snapshot, msg.schemas);
    const p: Placement = {
      id: shortId("pl"),
      workspaceId: msg.workspaceId,
      releaseId: null,
      outputId: msg.outputId,
      position: msg.position,
      yaw: msg.yaw,
      placedBy: user.id,
      grants: null,
    };
    s.placements.set(p.id, p);
    if (s.host) this.send(s.host, { t: "host.addPart", part: this.hostPart(s, p) });
    this.broadcastSession(s);
  }

  private hostPart(s: Session, p: Placement): HostPart {
    const snapshot = p.workspaceId ? s.builds.get(buildKey(p.workspaceId, p.outputId)) : p.snapshot;
    const packages = this.packagesOf(snapshot);
    const schemas =
      typeof snapshot === "object" && snapshot !== null ? this.schemas.get(snapshot) : undefined;
    return {
      id: p.id,
      // リリースから置いたものは、ワークスペースとは別の領域（KokoState の名前の範囲）にする
      realm: p.workspaceId ?? `rel_${p.releaseId}`,
      outputId: p.outputId,
      snapshot,
      ...(packages ? { packages } : {}),
      ...(schemas !== undefined ? { schemas } : {}),
      position: p.position,
      yaw: p.yaw,
      grants: p.grants,
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
    if (!this.repos) return this.deny(conn, "リポジトリを開けません");
    return this.repos.withRepoLock(repoId, () => this.openRepoLocked(conn, repoId));
  }

  private async openRepoLocked(conn: Conn, repoId: string): Promise<void> {
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
    if (msg.requestId && msg.sessionId) {
      const requestId = msg.requestId;
      const sessionId = msg.sessionId;
      const s = conn.session;
      const user = conn.user;
      const failure = (error: string): Extract<ServerMessage, { t: "placement.result" }> => ({
        t: "placement.result",
        requestId,
        sessionId,
        placementId: null,
        error,
      });
      if (!s || s.id !== sessionId || !user) {
        this.send(conn, failure("取り出し先のセッションが変わりました"));
        return;
      }
      const key = `${user.id}:${requestId}`;
      const fingerprint = JSON.stringify([msg.releaseId, msg.position, msg.yaw]);
      for (const [id, value] of s.placementRequests)
        if (value.until < Date.now()) s.placementRequests.delete(id);
      const previous = s.placementRequests.get(key);
      if (previous) {
        this.send(
          conn,
          previous.fingerprint === fingerprint
            ? await previous.result
            : failure("同じ要求IDで内容を変えることはできません"),
        );
        return;
      }
      if (s.placementRequests.size >= 512) {
        this.send(conn, failure("取り出しが混み合っています。少し待ってからお試しください"));
        return;
      }
      const result = (async () => {
        try {
          const loaded = await this.loadRelease(msg.releaseId);
          if (!loaded) return failure("バージョンが見つかりません");
          const current = await this.store.work(loaded.work.id);
          if (!current || !(await this.canUse(user.id, current)))
            return failure("このリリースを利用する権限がありません");
          if (conn.session !== s || !this.sessions.has(s.id))
            return failure("取り出し先のセッションが変わりました");
          if (loaded.snapshot.outputs.find((o) => o.id === loaded.work.outputId)?.kind !== "item")
            return failure("取り出せるのはアイテムです");
          const placementId = this.addReleasePlacement(s, user.id, loaded, msg.position, msg.yaw);
          this.broadcastSession(s);
          return { t: "placement.result" as const, requestId, sessionId, placementId, error: null };
        } catch {
          return failure("アイテムを取り出せませんでした。もう一度お試しください");
        }
      })();
      s.placementRequests.set(key, { fingerprint, result, until: Number.POSITIVE_INFINITY });
      const response = await result;
      const entry = s.placementRequests.get(key);
      if (entry) entry.until = Date.now() + 5 * 60_000;
      this.send(conn, response);
      return;
    }
    const s = conn.session;
    const user = conn.user;
    if (!s || !user || !this.repos) return;
    const loaded = await this.loadRelease(msg.releaseId);
    if (!loaded) return this.deny(conn, "バージョンが見つかりません");
    if (!(await this.canUse(user.id, loaded.work))) {
      return this.deny(conn, "このリリースを利用する権限がありません");
    }
    const kind = loaded.snapshot.outputs.find((o) => o.id === loaded.work.outputId)?.kind;
    if (kind === "library") {
      return this.deny(conn, "ライブラリは置けません。ほかのプロジェクトから import して使います");
    }
    this.addReleasePlacement(s, user.id, loaded, msg.position, msg.yaw);
    this.broadcastSession(s);
  }

  /**
   * 公開されたワールドを、このセッションのルートワールドにする（ADR 0014・0066）。
   * すぐには入れ替えず、全員へカウントダウンを出してから入れ替える。
   */
  private async openWorld(conn: Conn, releaseId: string): Promise<void> {
    const s = conn.session;
    const user = conn.user;
    if (!s || !user) return;
    const ready = await this.loadUsableWorld(conn, releaseId);
    if (!ready.ok) return this.deny(conn, ready.message);
    const loaded = ready.loaded;
    const worlds = [...s.placements.values()].filter((p) => this.placementKind(s, p) === "world");
    // すでにそのリリースだけが開いているときは、何もしない（実行状態は戻さない。ADR 0014）
    if (worlds.length === 1 && worlds[0]?.releaseId === loaded.release.id) {
      this.broadcastSession(s);
      return;
    }
    if (s.worldChange?.releaseId === loaded.release.id) return;
    this.scheduleWorldChange(s, user, loaded);
  }

  /** 利用の権限があり、マーケットで有料なら入手しているか */
  private canUse(
    userId: string,
    work: { id: string; owner: string; perms: { use: boolean } },
  ): Promise<boolean> {
    if (this.catalog) return this.catalog.canUse(userId, work);
    return Promise.resolve(work.perms.use || work.owner === userId);
  }

  /** 利用できるワールドのリリースか。開けないときは、その理由を返す */
  private async loadUsableWorld(
    conn: Conn,
    releaseId: string,
  ): Promise<{ ok: true; loaded: LoadedRelease } | { ok: false; message: string }> {
    if (!conn.user || !this.repos) return { ok: false, message: "バージョンが見つかりません" };
    const loaded = await this.loadRelease(releaseId);
    if (!loaded) return { ok: false, message: "バージョンが見つかりません" };
    if (!(await this.canUse(conn.user.id, loaded.work))) {
      return {
        ok: false,
        message: loaded.work.perms.use
          ? "このワールドは有料です。マーケットで入手すると開けます"
          : "このリリースを利用する権限がありません",
      };
    }
    const kind = loaded.snapshot.outputs.find((o) => o.id === loaded.work.outputId)?.kind;
    if (kind !== "world") return { ok: false, message: "ワールドではありません" };
    return { ok: true, loaded };
  }

  /** 開いていたワールドを外し、選んだリリースを原点に置く。アイテムは残る */
  private installWorld(s: Session, userId: string, loaded: LoadedRelease): void {
    const worlds = [...s.placements.values()].filter((p) => this.placementKind(s, p) === "world");
    for (const p of worlds) {
      s.placements.delete(p.id);
      if (s.host) this.send(s.host, { t: "host.removePart", id: p.id });
    }
    this.addReleasePlacement(s, userId, loaded, [0, 0, 0], 0);
  }

  /** 全員へ残り時間を知らせ、数え終わってからルートワールドを入れ替える */
  private scheduleWorldChange(s: Session, user: User, loaded: LoadedRelease): void {
    this.clearWorldChange(s);
    const id = shortId("wc");
    const delay = this.opts.worldChangeMs;
    const at = Date.now() + delay;
    const timer = setTimeout(() => {
      if (s.worldChange?.id !== id || !this.sessions.has(s.id)) return;
      s.worldChange = null;
      this.installWorld(s, user.id, loaded);
      this.broadcastSession(s);
    }, delay);
    const output = loaded.snapshot.outputs.find((o) => o.id === loaded.work.outputId);
    s.worldChange = {
      id,
      releaseId: loaded.release.id,
      worldName: output?.name || loaded.work.name,
      byName: user.name,
      at,
      timer,
    };
    this.broadcastSession(s);
  }

  private clearWorldChange(s: Session): void {
    if (!s.worldChange) return;
    clearTimeout(s.worldChange.timer);
    s.worldChange = null;
  }

  private async loadRelease(releaseId: string): Promise<LoadedRelease | null> {
    if (!this.repos) return null;
    const release = await this.store.release(releaseId);
    const work = release ? await this.store.work(release.workId) : null;
    if (!release || !work) return null;
    const snapshot = await this.repos.snapshot(work.repoId, release.commit);
    // リリースの依存は、作品の持ち主の許可で取り出す
    if (hasDependencies(snapshot)) await this.attachPackages(snapshot, work.owner);
    // リリースのフィールドのスキーマは、サーバーが作って付ける。セッションのホストは、
    // TypeScript を読み込まずに値を確かめられる（ADR 0065）
    let schemas = this.releaseSchemas.get(release.id);
    if (schemas === undefined) {
      schemas = fieldSchemasOf(snapshot, packagesByAlias(this.packagesOf(snapshot)));
      this.releaseSchemas.set(release.id, schemas);
    }
    this.schemas.set(snapshot, schemas);
    return { release, work, snapshot };
  }

  /** 出した人の画面が作ったスキーマを、制作データに結び付けて覚える（ホストへ一緒に渡す） */
  private rememberSchemas(snapshot: unknown, schemas: unknown): void {
    if (schemas !== undefined && typeof snapshot === "object" && snapshot !== null)
      this.schemas.set(snapshot, schemas);
  }

  /** 制作データの依存の中身を、持ち主の許可で取り出して覚える（ADR 0015） */
  private async attachPackages(snapshot: unknown, ownerId: string | null): Promise<void> {
    if (!this.repos || typeof snapshot !== "object" || snapshot === null) return;
    const resolved = await this.repos.resolveDependencies(
      snapshot as Pick<ProjectSnapshot, "dependencies">,
      ownerId ? { id: ownerId } : null,
    );
    this.packages.set(snapshot, resolved);
  }

  private packagesOf(snapshot: unknown): PackageResolution[] | undefined {
    return typeof snapshot === "object" && snapshot !== null
      ? this.packages.get(snapshot)
      : undefined;
  }

  /** ワークスペースのリポジトリの持ち主（依存の中身を取り出す許可に使う） */
  private async workspaceOwner(w: Workspace): Promise<string | null> {
    return w.meta.repoId ? ((await this.store.repo(w.meta.repoId))?.owner ?? null) : null;
  }

  private addReleasePlacement(
    s: Session,
    userId: string,
    loaded: {
      release: { id: string; version: number };
      work: { name: string; outputId: string };
      snapshot: unknown;
    },
    position: [number, number, number],
    yaw: number,
  ): string {
    const p: Placement = {
      id: shortId("pl"),
      workspaceId: null,
      releaseId: loaded.release.id,
      snapshot: loaded.snapshot,
      label: `${loaded.work.name} v${loaded.release.version}`,
      outputId: loaded.work.outputId,
      position,
      yaw,
      placedBy: userId,
      grants: null,
    };
    s.placements.set(p.id, p);
    if (s.host) this.send(s.host, { t: "host.addPart", part: this.hostPart(s, p) });
    return p.id;
  }

  private placementSnapshot(
    s: Session,
    p: Placement,
  ): { outputs?: { id: string; name?: string; kind?: string }[] } | undefined {
    return (p.workspaceId ? s.builds.get(buildKey(p.workspaceId, p.outputId)) : p.snapshot) as
      | { outputs?: { id: string; name?: string; kind?: string }[] }
      | undefined;
  }

  private placementKind(s: Session, p: Placement): "item" | "world" | "library" | null {
    const kind = this.placementSnapshot(s, p)?.outputs?.find((o) => o.id === p.outputId)?.kind;
    return kind === "item" || kind === "world" || kind === "library" ? kind : null;
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
      ended: false,
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
    if (!w.host && role === "admin" && !conn.agent) this.setHost(w, conn);
    else if (w.lastFrame) this.send(conn, { t: "ws.frame", workspaceId, frame: w.lastFrame });
    this.broadcastSession(s);
  }

  /** この接続だけ出る。ワークスペースはセッションに残る。 */
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

  /**
   * ワークスペースを閉じる。セッションの一覧からなくなり、開いていた人も出る。
   * 制作データは保存したまま残し、プロジェクトから開き直せる。
   * セッションに出した配置は残る。
   */
  private async endWorkspace(conn: Conn, workspaceId: string): Promise<void> {
    const user = conn.user;
    const w = this.workspaces.get(workspaceId);
    if (!user || !conn.session || !w || w.session !== conn.session) {
      return this.deny(conn, "ワークスペースが見つかりません");
    }
    if (this.roleOf(w, user.id) !== "admin") {
      return this.deny(conn, "閉じられるのは、管理権限を持つ人です");
    }
    if (w.saveTimer) {
      clearTimeout(w.saveTimer);
      w.saveTimer = null;
    }
    // これ以降の自動保存は、閉じる直前の内容を古い状態で上書きしない
    w.ended = true;
    try {
      await (w.saveTail ?? Promise.resolve()).catch(() => undefined);
      await this.store.saveDoc(w.meta.id, Y.encodeStateAsUpdate(w.room.doc));
    } catch {
      w.ended = false;
      return this.deny(conn, "保存できなかったので、閉じられませんでした");
    }
    const session = w.session;
    const reason = `${user.name} がワークスペースを閉じました。プロジェクトは残ります。`;
    for (const c of [...w.conns]) {
      c.open.delete(w.meta.id);
      w.room.leave(c.id);
      this.send(c, { t: "ws.ended", workspaceId: w.meta.id, reason });
    }
    w.conns.clear();
    w.host = null;
    w.room.doc.destroy();
    session.workspaces.delete(w.meta.id);
    this.workspaces.delete(w.meta.id);
    this.broadcastSession(session);
  }

  private setHost(w: Workspace, conn: Conn): void {
    w.host = conn;
    this.send(conn, { t: "ws.host", workspaceId: w.meta.id, resume: w.lastFrame });
    this.opts.log(`host of ${w.meta.id} -> ${conn.user?.id}`);
  }

  /** ホストが抜けたら、ワークスペースを開いている管理者に引き継ぐ。いなければ再生を止める。 */
  private migrateHost(w: Workspace): void {
    w.host = null;
    const next = [...w.conns].find(
      (c) => c.user && !c.agent && this.roleOf(w, c.user.id) === "admin",
    );
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
        partEntities: {},
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
      } else if (!w.host && r === "admin" && !c.agent) {
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
    if (w.ended || w.saveTimer) return;
    w.saveTimer = setTimeout(() => {
      w.saveTimer = null;
      void this.saveNow(w);
    }, this.opts.saveDelayMs);
  }

  private async saveNow(w: Workspace): Promise<void> {
    if (w.ended) return;
    if (w.saveTimer) {
      clearTimeout(w.saveTimer);
      w.saveTimer = null;
    }
    const state = Y.encodeStateAsUpdate(w.room.doc);
    const write = () => this.store.saveDoc(w.meta.id, state);
    const task = (w.saveTail ?? Promise.resolve()).then(write, write);
    w.saveTail = task;
    await task;
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
    // 公開した作品のサムネイルは、マーケットで誰にでも見せる（リリースした版のもの。ADR 0046）
    for (const w of await this.store.works()) {
      const latest = (await this.store.releases(w.id))[0];
      if (!latest) continue;
      const snap = await this.repos.snapshot(w.repoId, latest.commit).catch(() => null);
      if (snap?.outputs.find((o) => o.id === w.outputId)?.thumbnail === assetId) return true;
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
    this.failShots(conn);
    this.leaveSession(conn);
    this.conns.delete(conn.id);
    if (conn.user) this.notifySocial(conn.user.id);
  }

  private toSession(s: Session, msg: ServerMessage, except?: Conn): void {
    const data = stringifyValue(msg);
    for (const c of s.conns) if (c !== except) c.peer.send(data);
  }

  private send(conn: Conn, msg: ServerMessage): void {
    conn.peer.send(stringifyValue(msg));
  }

  private deny(conn: Conn, message: string): void {
    this.send(conn, { t: "error", message });
  }

  private denyWs(conn: Conn, workspaceId: string, reason: string): void {
    this.send(conn, { t: "ws.denied", workspaceId, reason });
  }
}

/** 制作データに依存があるか（なければ、今までどおり待たずに進める） */
function hasDependencies(snapshot: unknown): boolean {
  const deps = (snapshot as { dependencies?: unknown } | null)?.dependencies;
  return Array.isArray(deps) && deps.length > 0;
}
