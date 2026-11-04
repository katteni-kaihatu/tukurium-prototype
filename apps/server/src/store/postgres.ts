import { createHash } from "node:crypto";
import postgres from "postgres";
import {
  newToken,
  newUserId,
  type OwnedItem,
  type Release,
  type RepoMeta,
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
}
