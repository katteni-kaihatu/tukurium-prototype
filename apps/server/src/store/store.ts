import { randomBytes, randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@tukurium/shared";

export interface User {
  id: string;
  name: string;
}

export interface WorkspaceMeta {
  id: string;
  name: string;
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
}

export const newToken = () => randomBytes(24).toString("base64url");
export const newUserId = () => `u_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** メモリ上の Store（テストと、DATABASE_URL がないときの開発用）。再起動で消える。 */
export class MemoryStore implements Store {
  private readonly users = new Map<string, User>();
  private readonly tokens = new Map<string, string>();
  private readonly workspaces = new Map<string, WorkspaceMeta>();
  private readonly docs = new Map<string, Uint8Array>();

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
}
