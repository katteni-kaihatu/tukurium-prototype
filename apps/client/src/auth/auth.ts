import type { UserInfo } from "@tukurium/shared";

/** ログインの状態（ADR 0074）。本人はサーバーが Cookie のセッションで決める */
export interface AuthState {
  user: UserInfo | null;
  /** ログインに使う Misskey のホスト（例：misskey.resonite.love） */
  misskeyHost: string;
  /** 開発用ログイン（名前だけで入る）が開いているか */
  devLogin: boolean;
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `エラー（${res.status}）`);
  return data;
}

export async function fetchAuth(): Promise<AuthState> {
  const res = await fetch("/api/auth/me", { cache: "no-store" });
  if (!res.ok) throw new Error(`サーバーに届きません（${res.status}）`);
  return (await res.json()) as AuthState;
}

/** Misskey の許可の画面へ移る。許可するとサーバーがログインの Cookie を付けて / へ戻す */
export async function loginWithMisskey(): Promise<void> {
  const { url } = await post<{ url: string }>("/api/auth/misskey/start");
  location.assign(url);
}

export async function devLogin(name: string): Promise<void> {
  await post("/api/auth/dev", { name });
}

export async function logout(): Promise<void> {
  await post("/api/auth/logout");
  location.assign("/");
}
