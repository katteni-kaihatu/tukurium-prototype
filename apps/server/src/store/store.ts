import { randomBytes, randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@tukurium/shared";

export interface User {
  id: string;
  name: string;
}

export interface RepoMeta {
  id: string;
  owner: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  /** 作るもの（item / world）の目安。あとから変えられる */
  kind: string;
  forkedFrom: { repoId: string; repoName: string; commit: string } | null;
  createdAt: string;
}

export interface WorkPerms {
  /** セッションで使う */
  use: boolean;
  /** 元データ（リポジトリ）を見る */
  view: boolean;
  /** フォーク・抽出する */
  fork: boolean;
}

/** 作品：アウトプットに対応し、権限と元リポジトリへのリンクを持つ公開単位 */
export interface Work {
  id: string;
  repoId: string;
  outputId: string;
  name: string;
  owner: string;
  perms: WorkPerms;
  createdAt: string;
}

/** リリース：作品の、特定のコミットからビルドしたバージョン */
export interface Release {
  id: string;
  workId: string;
  version: number;
  commit: string;
  createdAt: string;
  /**
   * ライブラリの作品だけ：公開したもの（manifest）の content hash（sha256）。
   * サーバーが計算する。同じ作品・同じ版の hash は変えない（ADR 0013・0015）
   */
  contentHash?: string;
}

export interface WorkspaceMeta {
  id: string;
  name: string;
  /** このワークスペースが編集しているリポジトリ */
  repoId?: string;
  /** 作った人（最初の管理者） */
  createdBy: string;
  defaultRole: WorkspaceRole | null;
  members: Record<string, WorkspaceRole>;
}

/**
 * 永続化する情報の置き場。セッションは保存しない（持ち主が閉じたらなくなる）。
 * ワークスペースの中身は Yjs の更新（バイナリ）として保存する（作業途中の自動保存）。
 */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;
  userByToken(token: string): Promise<User | null>;
  createUser(name: string): Promise<{ user: User; token: string }>;
  renameUser(id: string, name: string): Promise<void>;
  saveWorkspace(meta: WorkspaceMeta): Promise<void>;
  workspace(id: string): Promise<WorkspaceMeta | null>;
  saveDoc(workspaceId: string, state: Uint8Array): Promise<void>;
  loadDoc(workspaceId: string): Promise<Uint8Array | null>;
  user(id: string): Promise<User | null>;
  saveRepo(meta: RepoMeta): Promise<void>;
  repo(id: string): Promise<RepoMeta | null>;
  repos(filter?: { owner?: string }): Promise<RepoMeta[]>;
  saveWork(work: Work): Promise<void>;
  work(id: string): Promise<Work | null>;
  works(filter?: { repoId?: string; owner?: string }): Promise<Work[]>;
  saveRelease(r: Release): Promise<void>;
  releases(workId: string): Promise<Release[]>;
  release(id: string): Promise<Release | null>;
}

export const newToken = () => randomBytes(24).toString("base64url");
export const newUserId = () => `u_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** メモリ上の Store（テストと、DATABASE_URL がないときの開発用）。再起動で消える。 */
export class MemoryStore implements Store {
  private readonly users = new Map<string, User>();
  private readonly tokens = new Map<string, string>();
  private readonly workspaces = new Map<string, WorkspaceMeta>();
  private readonly docs = new Map<string, Uint8Array>();
  private readonly repoMap = new Map<string, RepoMeta>();
  private readonly workMap = new Map<string, Work>();
  private readonly releaseMap = new Map<string, Release>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async userByToken(token: string): Promise<User | null> {
    const id = this.tokens.get(token);
    return id ? (this.users.get(id) ?? null) : null;
  }
  async createUser(name: string) {
    const user = { id: newUserId(), name };
    const token = newToken();
    this.users.set(user.id, user);
    this.tokens.set(token, user.id);
    return { user: { ...user }, token };
  }
  async renameUser(id: string, name: string) {
    const u = this.users.get(id);
    if (u) u.name = name;
  }
  async saveWorkspace(meta: WorkspaceMeta) {
    this.workspaces.set(meta.id, structuredClone(meta));
  }
  async workspace(id: string) {
    const w = this.workspaces.get(id);
    return w ? structuredClone(w) : null;
  }
  async saveDoc(id: string, state: Uint8Array) {
    this.docs.set(id, state.slice());
  }
  async loadDoc(id: string) {
    return this.docs.get(id)?.slice() ?? null;
  }
  async user(id: string) {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }
  async saveRepo(meta: RepoMeta) {
    this.repoMap.set(meta.id, structuredClone(meta));
  }
  async repo(id: string) {
    const r = this.repoMap.get(id);
    return r ? structuredClone(r) : null;
  }
  async repos(filter: { owner?: string } = {}) {
    return [...this.repoMap.values()]
      .filter((r) => !filter.owner || r.owner === filter.owner)
      .map((r) => structuredClone(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async saveWork(w: Work) {
    this.workMap.set(w.id, structuredClone(w));
  }
  async work(id: string) {
    const w = this.workMap.get(id);
    return w ? structuredClone(w) : null;
  }
  async works(filter: { repoId?: string; owner?: string } = {}) {
    return [...this.workMap.values()]
      .filter(
        (w) =>
          (!filter.repoId || w.repoId === filter.repoId) &&
          (!filter.owner || w.owner === filter.owner),
      )
      .map((w) => structuredClone(w))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async saveRelease(r: Release) {
    this.releaseMap.set(r.id, structuredClone(r));
  }
  async releases(workId: string) {
    return [...this.releaseMap.values()]
      .filter((r) => r.workId === workId)
      .map((r) => structuredClone(r))
      .sort((a, b) => b.version - a.version);
  }
  async release(id: string) {
    const r = this.releaseMap.get(id);
    return r ? structuredClone(r) : null;
  }
}
