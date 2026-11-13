import { randomBytes, randomUUID } from "node:crypto";
import type { SocialProfile, WorkspaceRole } from "@tukurium/shared";

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
  /** 作者が付けた公開タグ。旧データでは省略されている。 */
  tags?: string[];
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

export interface OwnedItem {
  userId: string;
  workId: string;
  releaseId: string;
  acquiredAt: string;
}

/** はじめの所持金（ポイント）。まだ記録のない人はこの額を持っている。 */
export const DEFAULT_BALANCE = 1000;
/** 売れたとき作者に入る割合（残りは消える） */
export const AUTHOR_SHARE = 0.9;

/**
 * マーケットへの登録。作品（リリース）ごとに一つ。登録したものだけがマーケットに出て、入手できる。
 * 自動公開がオンなら、新しい版を出したときに公開する版も替わる。
 */
export interface Listing {
  workId: string;
  owner: string;
  /** 価格（ポイント）。0 は無料 */
  price: number;
  autoPublish: boolean;
  /** マーケットで公開している版 */
  releaseId: string;
  listedAt: string;
  updatedAt: string;
}

/** マーケットの履歴（誰でも見える。入手の記録は含めない） */
export type MarketEvent = {
  id: string;
  workId: string;
  at: string;
} & (
  | { kind: "listed"; version: number; price: number }
  | { kind: "published"; version: number; auto: boolean }
  | { kind: "price"; from: number; to: number }
  | { kind: "unlisted" }
);

/** 入手の記録。買った人（buyerId）は作者に見せない。 */
export interface Sale {
  id: string;
  workId: string;
  sellerId: string;
  buyerId: string;
  releaseId: string;
  price: number;
  /** 作者に入ったポイント */
  earned: number;
  at: string;
}

export type PurchaseResult =
  | { ok: true; item: OwnedItem; balance: number; created: boolean }
  | { ok: false; reason: "funds"; balance: number };

export interface Friendship {
  from: string;
  to: string;
  status: "pending" | "accepted";
  createdAt: string;
}
export const friendshipKey = (a: string, b: string) => [a, b].sort().join(":");

export interface SessionInvitation {
  id: string;
  from: string;
  to: string;
  sessionId: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  createdAt: string;
  expiresAt: string;
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
  /** 決まった ID の利用者を用意する（なければ作る。ログインはできない。公式の発行者に使う） */
  ensureUser(user: User): Promise<void>;
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
  ownedItems(userId: string): Promise<OwnedItem[]>;
  acquireItem(item: OwnedItem): Promise<OwnedItem>;
  /** 所持している版を替える。所持していなければ null（入手日は変えない） */
  updateOwnedItem(userId: string, workId: string, releaseId: string): Promise<OwnedItem | null>;
  removeOwnedItem(userId: string, workId: string): Promise<void>;
  /** 所持金。記録がなければ DEFAULT_BALANCE */
  balance(userId: string): Promise<number>;
  listing(workId: string): Promise<Listing | null>;
  listings(filter?: { owner?: string }): Promise<Listing[]>;
  saveListing(listing: Listing): Promise<void>;
  removeListing(workId: string): Promise<void>;
  marketEvents(workId: string): Promise<MarketEvent[]>;
  addMarketEvent(event: MarketEvent): Promise<void>;
  /** 入手の記録（新しい順） */
  sales(filter: { sellerId?: string; workId?: string }): Promise<Sale[]>;
  /**
   * 入手をひとまとめに行う：もう持っていれば何もしない。所持金が足りなければ断る。
   * 足りれば買った人から引き、作者に sale.earned を足し、所持と記録を残す。
   */
  purchase(item: OwnedItem, sale: Sale): Promise<PurchaseResult>;
  searchUsers(query: string, limit: number): Promise<User[]>;
  friendships(userId: string): Promise<Friendship[]>;
  requestFriendship(request: Friendship): Promise<Friendship>;
  acceptFriendship(userId: string, from: string): Promise<Friendship | null>;
  removeFriendship(userId: string, other: string): Promise<void>;
  socialProfile(userId: string): Promise<SocialProfile>;
  saveSocialProfile(userId: string, profile: SocialProfile): Promise<void>;
  invitations(userId: string): Promise<SessionInvitation[]>;
  invitation(id: string): Promise<SessionInvitation | null>;
  createInvitation(invitation: SessionInvitation): Promise<SessionInvitation>;
  respondInvitation(
    id: string,
    actor: string,
    status: "accepted" | "declined" | "cancelled",
  ): Promise<SessionInvitation | null>;
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
  private readonly owned = new Map<string, OwnedItem>();
  private readonly friends = new Map<string, Friendship>();
  private readonly profiles = new Map<string, SocialProfile>();
  private readonly invites = new Map<string, SessionInvitation>();
  private readonly wallets = new Map<string, number>();
  private readonly listingMap = new Map<string, Listing>();
  private readonly events: MarketEvent[] = [];
  private readonly saleList: Sale[] = [];

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
  async ensureUser(user: User) {
    if (!this.users.has(user.id)) this.users.set(user.id, { ...user });
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

  async ownedItems(userId: string) {
    return [...this.owned.values()]
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt) || a.workId.localeCompare(b.workId))
      .map((item) => ({ ...item }));
  }

  async acquireItem(item: OwnedItem) {
    const key = `${item.userId}:${item.workId}`;
    const existing = this.owned.get(key);
    if (existing) return { ...existing };
    this.owned.set(key, { ...item });
    return { ...item };
  }

  async updateOwnedItem(userId: string, workId: string, releaseId: string) {
    const existing = this.owned.get(`${userId}:${workId}`);
    if (!existing) return null;
    existing.releaseId = releaseId;
    return { ...existing };
  }

  async removeOwnedItem(userId: string, workId: string) {
    this.owned.delete(`${userId}:${workId}`);
  }

  async balance(userId: string) {
    return this.wallets.get(userId) ?? DEFAULT_BALANCE;
  }
  async listing(workId: string) {
    const l = this.listingMap.get(workId);
    return l ? { ...l } : null;
  }
  async listings(filter: { owner?: string } = {}) {
    return [...this.listingMap.values()]
      .filter((l) => !filter.owner || l.owner === filter.owner)
      .map((l) => ({ ...l }));
  }
  async saveListing(listing: Listing) {
    this.listingMap.set(listing.workId, { ...listing });
  }
  async removeListing(workId: string) {
    this.listingMap.delete(workId);
  }
  async marketEvents(workId: string) {
    return this.events
      .filter((e) => e.workId === workId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((e) => ({ ...e }));
  }
  async addMarketEvent(event: MarketEvent) {
    this.events.push({ ...event });
  }
  async sales(filter: { sellerId?: string; workId?: string }) {
    return this.saleList
      .filter(
        (s) =>
          (!filter.sellerId || s.sellerId === filter.sellerId) &&
          (!filter.workId || s.workId === filter.workId),
      )
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((s) => ({ ...s }));
  }
  async purchase(item: OwnedItem, sale: Sale): Promise<PurchaseResult> {
    const key = `${item.userId}:${item.workId}`;
    const existing = this.owned.get(key);
    // 途中で await しない（同時の入手で二重に引かないように、ひと続きで行う）
    const balance = this.wallets.get(item.userId) ?? DEFAULT_BALANCE;
    if (existing) return { ok: true, item: { ...existing }, balance, created: false };
    if (balance < sale.price) return { ok: false, reason: "funds", balance };
    this.wallets.set(item.userId, balance - sale.price);
    if (sale.sellerId !== item.userId)
      this.wallets.set(
        sale.sellerId,
        (this.wallets.get(sale.sellerId) ?? DEFAULT_BALANCE) + sale.earned,
      );
    this.owned.set(key, { ...item });
    this.saleList.push({ ...sale });
    return { ok: true, item: { ...item }, balance: balance - sale.price, created: true };
  }

  async searchUsers(query: string, limit: number) {
    const needle = query.toLocaleLowerCase();
    return [...this.users.values()]
      .filter((u) => u.id === query || u.name.toLocaleLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((u) => ({ ...u }));
  }
  async friendships(userId: string) {
    return [...this.friends.values()]
      .filter((f) => f.from === userId || f.to === userId)
      .map((f) => ({ ...f }));
  }
  async requestFriendship(request: Friendship) {
    const key = friendshipKey(request.from, request.to);
    const saved = this.friends.get(key) ?? { ...request };
    this.friends.set(key, saved);
    return { ...saved };
  }
  async acceptFriendship(userId: string, from: string) {
    const key = friendshipKey(userId, from);
    const saved = this.friends.get(key);
    if (!saved || (saved.status === "pending" && (saved.to !== userId || saved.from !== from)))
      return null;
    saved.status = "accepted";
    return { ...saved };
  }
  async removeFriendship(userId: string, other: string) {
    this.friends.delete(friendshipKey(userId, other));
  }
  async socialProfile(userId: string): Promise<SocialProfile> {
    return { ...(this.profiles.get(userId) ?? { availability: "online", note: "" }) };
  }
  async saveSocialProfile(userId: string, profile: SocialProfile) {
    this.profiles.set(userId, { ...profile });
  }

  async invitations(userId: string) {
    return [...this.invites.values()]
      .filter((i) => i.from === userId || i.to === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
      .map((i) => ({ ...i }));
  }
  async invitation(id: string) {
    const value = [...this.invites.values()].find((i) => i.id === id);
    return value ? { ...value } : null;
  }
  async createInvitation(invitation: SessionInvitation) {
    const key = `${invitation.from}:${invitation.to}:${invitation.sessionId}`;
    const old = this.invites.get(key);
    if (old?.status === "pending" && old.expiresAt > new Date().toISOString()) return { ...old };
    this.invites.set(key, { ...invitation });
    return { ...invitation };
  }
  async respondInvitation(
    id: string,
    actor: string,
    status: "accepted" | "declined" | "cancelled",
  ) {
    const value = [...this.invites.values()].find((i) => i.id === id);
    if (
      !value ||
      (status === "cancelled" ? value.from !== actor : value.to !== actor) ||
      value.expiresAt <= new Date().toISOString() ||
      value.status !== "pending"
    )
      return null;
    value.status = status;
    return { ...value };
  }
}
