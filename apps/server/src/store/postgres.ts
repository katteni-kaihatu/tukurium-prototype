import { createHash } from "node:crypto";
import type { SocialProfile } from "@tukurium/shared";
import postgres from "postgres";
import {
  DEFAULT_BALANCE,
  type Friendship,
  type Listing,
  type MarketEvent,
  newToken,
  newUserId,
  type OwnedItem,
  type PurchaseResult,
  type Release,
  type RepoMeta,
  type Sale,
  type SessionInvitation,
  type Store,
  type User,
  type Work,
  type WorkspaceMeta,
} from "./store";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** PostgreSQL の Store。テーブルは起動時に作る（初版は簡易なマイグレーション）。 */
export class PostgresStore implements Store {
  private readonly sql: postgres.Sql;

  constructor(url: string) {
    this.sql = postgres(url, { max: 5, onnotice: () => {} });
  }

  async init(): Promise<void> {
    await this.sql`
      create table if not exists users (
        id text primary key,
        name text not null,
        token_hash text not null unique,
        created_at timestamptz not null default now()
      )`;
    await this.sql`
      create table if not exists workspaces (
        id text primary key,
        meta jsonb not null,
        doc bytea,
        updated_at timestamptz not null default now()
      )`;
    // リポジトリ・作品・リリースは JSON で持ち、検索に使う列だけ別に持つ
    await this
      .sql`create table if not exists repos (id text primary key, owner text not null, data jsonb not null)`;
    await this
      .sql`create table if not exists works (id text primary key, repo_id text not null, owner text not null, data jsonb not null)`;
    await this
      .sql`create table if not exists releases (id text primary key, work_id text not null, data jsonb not null)`;
    await this.sql`create table if not exists owned_items (
      user_id text not null, work_id text not null, data jsonb not null,
      primary key (user_id, work_id))`;
    // マーケット：所持金・登録・履歴・入手の記録
    await this
      .sql`create table if not exists wallets (user_id text primary key, balance integer not null)`;
    await this
      .sql`create table if not exists listings (work_id text primary key, owner text not null, data jsonb not null)`;
    await this
      .sql`create table if not exists market_events (id text primary key, work_id text not null, at text not null, data jsonb not null)`;
    await this.sql`create index if not exists market_events_work_id on market_events(work_id)`;
    await this
      .sql`create table if not exists sales (id text primary key, work_id text not null, seller_id text not null, at text not null, data jsonb not null)`;
    await this.sql`create index if not exists sales_seller_id on sales(seller_id)`;
    await this.sql`create index if not exists sales_work_id on sales(work_id)`;
    await this
      .sql`create table if not exists friend_links (left_id text not null, right_id text not null, data jsonb not null, primary key(left_id,right_id))`;
    await this.sql`create index if not exists friend_links_right_id on friend_links(right_id)`;
    await this
      .sql`create table if not exists social_profiles (user_id text primary key, data jsonb not null)`;
    await this
      .sql`create table if not exists session_invitations (id text unique not null, sender text not null, recipient text not null, session_id text not null, data jsonb not null, primary key(sender,recipient,session_id))`;
    await this
      .sql`create index if not exists session_invitations_recipient on session_invitations(recipient)`;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async userByToken(token: string): Promise<User | null> {
    const rows = await this.sql<
      User[]
    >`select id, name from users where token_hash = ${hash(token)}`;
    return rows[0] ?? null;
  }

  async createUser(name: string) {
    const user = { id: newUserId(), name };
    const token = newToken();
    await this
      .sql`insert into users (id, name, token_hash) values (${user.id}, ${name}, ${hash(token)})`;
    return { user, token };
  }

  async ensureUser(user: User) {
    // token は使わない（誰も知らない値の hash を入れて、ログインできないようにする）
    await this
      .sql`insert into users (id, name, token_hash) values (${user.id}, ${user.name}, ${hash(newToken())}) on conflict (id) do nothing`;
  }

  async renameUser(id: string, name: string) {
    await this.sql`update users set name = ${name} where id = ${id}`;
  }

  async saveWorkspace(meta: WorkspaceMeta) {
    await this.sql`
      insert into workspaces (id, meta) values (${meta.id}, ${this.sql.json(meta as never)})
      on conflict (id) do update set meta = excluded.meta, updated_at = now()`;
  }

  async workspace(id: string) {
    const rows = await this.sql<
      { meta: WorkspaceMeta }[]
    >`select meta from workspaces where id = ${id}`;
    return rows[0]?.meta ?? null;
  }

  async saveDoc(id: string, state: Uint8Array) {
    await this
      .sql`update workspaces set doc = ${Buffer.from(state)}, updated_at = now() where id = ${id}`;
  }

  async user(id: string) {
    const rows = await this.sql<User[]>`select id, name from users where id = ${id}`;
    return rows[0] ?? null;
  }

  async saveRepo(meta: RepoMeta) {
    await this.sql`
      insert into repos (id, owner, data) values (${meta.id}, ${meta.owner}, ${this.sql.json(meta as never)})
      on conflict (id) do update set owner = excluded.owner, data = excluded.data`;
  }

  async repo(id: string) {
    const rows = await this.sql<{ data: RepoMeta }[]>`select data from repos where id = ${id}`;
    return rows[0]?.data ?? null;
  }

  async repos(filter: { owner?: string } = {}) {
    const rows = filter.owner
      ? await this.sql<{ data: RepoMeta }[]>`select data from repos where owner = ${filter.owner}`
      : await this.sql<{ data: RepoMeta }[]>`select data from repos`;
    return rows.map((r) => r.data).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveWork(w: Work) {
    await this.sql`
      insert into works (id, repo_id, owner, data) values (${w.id}, ${w.repoId}, ${w.owner}, ${this.sql.json(w as never)})
      on conflict (id) do update set data = excluded.data`;
  }

  async work(id: string) {
    const rows = await this.sql<{ data: Work }[]>`select data from works where id = ${id}`;
    return rows[0]?.data ?? null;
  }

  async works(filter: { repoId?: string; owner?: string } = {}) {
    const rows = filter.repoId
      ? await this.sql<{ data: Work }[]>`select data from works where repo_id = ${filter.repoId}`
      : filter.owner
        ? await this.sql<{ data: Work }[]>`select data from works where owner = ${filter.owner}`
        : await this.sql<{ data: Work }[]>`select data from works`;
    return rows.map((r) => r.data).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveRelease(r: Release) {
    await this.sql`
      insert into releases (id, work_id, data) values (${r.id}, ${r.workId}, ${this.sql.json(r as never)})
      on conflict (id) do update set data = excluded.data`;
  }

  async releases(workId: string) {
    const rows = await this.sql<
      { data: Release }[]
    >`select data from releases where work_id = ${workId}`;
    return rows.map((r) => r.data).sort((a, b) => b.version - a.version);
  }

  async release(id: string) {
    const rows = await this.sql<{ data: Release }[]>`select data from releases where id = ${id}`;
    return rows[0]?.data ?? null;
  }

  async loadDoc(id: string) {
    const rows = await this.sql<
      { doc: Buffer | null }[]
    >`select doc from workspaces where id = ${id}`;
    const doc = rows[0]?.doc;
    return doc ? new Uint8Array(doc) : null;
  }

  async ownedItems(userId: string) {
    const rows = await this.sql<
      { data: OwnedItem }[]
    >`select data from owned_items where user_id = ${userId}`;
    return rows
      .map((r) => r.data)
      .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt) || a.workId.localeCompare(b.workId));
  }

  async acquireItem(item: OwnedItem): Promise<OwnedItem> {
    await this.sql`insert into owned_items (user_id, work_id, data)
      values (${item.userId}, ${item.workId}, ${this.sql.json(item as never)})
      on conflict (user_id, work_id) do nothing`;
    const rows = await this.sql<
      { data: OwnedItem }[]
    >`select data from owned_items where user_id = ${item.userId} and work_id = ${item.workId}`;
    const saved = rows[0];
    if (!saved) throw new Error("所持アイテムを保存できませんでした");
    return saved.data;
  }

  async updateOwnedItem(userId: string, workId: string, releaseId: string) {
    const rows = await this.sql<{ data: OwnedItem }[]>`update owned_items
      set data = jsonb_set(data, '{releaseId}', to_jsonb(${releaseId}::text))
      where user_id = ${userId} and work_id = ${workId}
      returning data`;
    return rows[0]?.data ?? null;
  }

  async removeOwnedItem(userId: string, workId: string) {
    await this.sql`delete from owned_items where user_id = ${userId} and work_id = ${workId}`;
  }

  async balance(userId: string) {
    const rows = await this.sql<
      { balance: number }[]
    >`select balance from wallets where user_id = ${userId}`;
    return rows[0]?.balance ?? DEFAULT_BALANCE;
  }

  async listing(workId: string) {
    const rows = await this.sql<
      { data: Listing }[]
    >`select data from listings where work_id = ${workId}`;
    return rows[0]?.data ?? null;
  }

  async listings(filter: { owner?: string } = {}) {
    const rows = filter.owner
      ? await this.sql<{ data: Listing }[]>`select data from listings where owner = ${filter.owner}`
      : await this.sql<{ data: Listing }[]>`select data from listings`;
    return rows.map((r) => r.data);
  }

  async saveListing(listing: Listing) {
    await this.sql`
      insert into listings (work_id, owner, data) values (${listing.workId}, ${listing.owner}, ${this.sql.json(listing as never)})
      on conflict (work_id) do update set owner = excluded.owner, data = excluded.data`;
  }

  async removeListing(workId: string) {
    await this.sql`delete from listings where work_id = ${workId}`;
  }

  async marketEvents(workId: string) {
    const rows = await this.sql<
      { data: MarketEvent }[]
    >`select data from market_events where work_id = ${workId} order by at desc`;
    return rows.map((r) => r.data);
  }

  async addMarketEvent(event: MarketEvent) {
    await this.sql`insert into market_events (id, work_id, at, data)
      values (${event.id}, ${event.workId}, ${event.at}, ${this.sql.json(event as never)})`;
  }

  async sales(filter: { sellerId?: string; workId?: string }) {
    const rows = filter.workId
      ? await this.sql<
          { data: Sale }[]
        >`select data from sales where work_id = ${filter.workId} order by at desc`
      : filter.sellerId
        ? await this.sql<
            { data: Sale }[]
          >`select data from sales where seller_id = ${filter.sellerId} order by at desc`
        : await this.sql<{ data: Sale }[]>`select data from sales order by at desc`;
    return rows
      .map((r) => r.data)
      .filter((s) => !filter.sellerId || s.sellerId === filter.sellerId);
  }

  async purchase(item: OwnedItem, sale: Sale): Promise<PurchaseResult> {
    return this.sql.begin(async (tx) => {
      // 買う人の財布を先に作って行をロックし、同時の入手で二重に引かないようにする
      await tx`insert into wallets (user_id, balance) values (${item.userId}, ${DEFAULT_BALANCE})
        on conflict (user_id) do nothing`;
      const [wallet] = await tx<
        { balance: number }[]
      >`select balance from wallets where user_id = ${item.userId} for update`;
      const balance = wallet?.balance ?? DEFAULT_BALANCE;
      const [existing] = await tx<
        { data: OwnedItem }[]
      >`select data from owned_items where user_id = ${item.userId} and work_id = ${item.workId}`;
      if (existing) return { ok: true as const, item: existing.data, balance, created: false };
      if (balance < sale.price) return { ok: false as const, reason: "funds" as const, balance };
      await tx`update wallets set balance = balance - ${sale.price} where user_id = ${item.userId}`;
      if (sale.sellerId !== item.userId) {
        await tx`insert into wallets (user_id, balance) values (${sale.sellerId}, ${DEFAULT_BALANCE + sale.earned})
          on conflict (user_id) do update set balance = wallets.balance + ${sale.earned}`;
      }
      await tx`insert into owned_items (user_id, work_id, data)
        values (${item.userId}, ${item.workId}, ${tx.json(item as never)})`;
      await tx`insert into sales (id, work_id, seller_id, at, data)
        values (${sale.id}, ${sale.workId}, ${sale.sellerId}, ${sale.at}, ${tx.json(sale as never)})`;
      return { ok: true as const, item, balance: balance - sale.price, created: true };
    }) as Promise<PurchaseResult>;
  }

  async searchUsers(query: string, limit: number) {
    return this.sql<
      User[]
    >`select id,name from users where id=${query} or position(lower(${query}) in lower(name))>0 order by name,id limit ${limit}`;
  }
  async friendships(userId: string) {
    const rows = await this.sql<
      { data: Friendship }[]
    >`select data from friend_links where left_id=${userId} or right_id=${userId}`;
    return rows.map((r) => r.data);
  }
  async requestFriendship(request: Friendship) {
    const [a, b] = [request.from, request.to].sort() as [string, string];
    await this
      .sql`insert into friend_links (left_id,right_id,data) values (${a},${b},${this.sql.json(request as never)}) on conflict(left_id,right_id) do nothing`;
    const rows = await this.sql<
      { data: Friendship }[]
    >`select data from friend_links where left_id=${a} and right_id=${b}`;
    const saved = rows[0];
    if (!saved) throw new Error("申請を保存できませんでした");
    return saved.data;
  }
  async acceptFriendship(userId: string, from: string) {
    const [a, b] = [userId, from].sort() as [string, string];
    const rows = await this.sql<
      { data: Friendship }[]
    >`update friend_links set data=jsonb_set(data,'{status}','"accepted"'::jsonb) where left_id=${a} and right_id=${b} and (data->>'status'='accepted' or (data->>'from'=${from} and data->>'to'=${userId})) returning data`;
    return rows[0]?.data ?? null;
  }
  async removeFriendship(userId: string, other: string) {
    const [a, b] = [userId, other].sort() as [string, string];
    await this.sql`delete from friend_links where left_id=${a} and right_id=${b}`;
  }
  async socialProfile(userId: string): Promise<SocialProfile> {
    const rows = await this.sql<
      { data: SocialProfile }[]
    >`select data from social_profiles where user_id=${userId}`;
    return rows[0]?.data ?? { availability: "online", note: "" };
  }
  async saveSocialProfile(userId: string, profile: SocialProfile) {
    await this
      .sql`insert into social_profiles (user_id,data) values (${userId},${this.sql.json(profile as never)}) on conflict(user_id) do update set data=excluded.data`;
  }

  async invitations(userId: string) {
    const rows = await this.sql<
      { data: SessionInvitation }[]
    >`select data from session_invitations where sender=${userId} or recipient=${userId} order by data->>'createdAt' desc limit 100`;
    return rows.map((r) => r.data);
  }
  async invitation(id: string) {
    const rows = await this.sql<
      { data: SessionInvitation }[]
    >`select data from session_invitations where id=${id}`;
    return rows[0]?.data ?? null;
  }
  async createInvitation(invitation: SessionInvitation) {
    const rows = await this.sql<
      { data: SessionInvitation }[]
    >`insert into session_invitations (id,sender,recipient,session_id,data) values (${invitation.id},${invitation.from},${invitation.to},${invitation.sessionId},${this.sql.json(invitation as never)})
      on conflict(sender,recipient,session_id) do update set
      id=case when session_invitations.data->>'status'='pending' and (session_invitations.data->>'expiresAt')::timestamptz>now() then session_invitations.id else excluded.id end,
      data=case when session_invitations.data->>'status'='pending' and (session_invitations.data->>'expiresAt')::timestamptz>now() then session_invitations.data else excluded.data end returning data`;
    const saved = rows[0];
    if (!saved) throw new Error("招待を保存できませんでした");
    return saved.data;
  }
  async respondInvitation(
    id: string,
    actor: string,
    status: "accepted" | "declined" | "cancelled",
  ) {
    const rows = await this.sql<
      { data: SessionInvitation }[]
    >`update session_invitations set data=jsonb_set(data,'{status}',to_jsonb(${status}::text)) where id=${id} and data->>'status'='pending' and (data->>'expiresAt')::timestamptz>now() and (case when ${status}='cancelled' then sender=${actor} else recipient=${actor} end) returning data`;
    return rows[0]?.data ?? null;
  }
}
