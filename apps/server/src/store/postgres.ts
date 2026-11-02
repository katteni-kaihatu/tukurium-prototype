import { createHash } from "node:crypto";
import postgres from "postgres";
import { newToken, newUserId, type Store, type User, type WorkspaceMeta } from "./store";

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

  async loadDoc(id: string) {
    const rows = await this.sql<
      { doc: Buffer | null }[]
    >`select doc from workspaces where id = ${id}`;
    const doc = rows[0]?.doc;
    return doc ? new Uint8Array(doc) : null;
  }
}
