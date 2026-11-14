import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { type Store, type User, userInfo } from "../store/store";

/**
 * ログイン（ADR 0074）。Misskey の OAuth 2.0（認可コード＋PKCE）で本人を確かめ、
 * HttpOnly の Cookie のセッションで本人を決める。画面から名乗った名前や ID は信じない。
 */

export const SESSION_COOKIE = "tukurium_session";
/** ログインを始めたブラウザの印。Misskey から戻ってきたブラウザが、これを持っているときだけ入れる */
const PENDING_COOKIE = "tukurium_login";
const DAY = 86_400_000;
const SESSION_TTL = 90 * DAY;
/** 期限の延長で毎回書かないよう、残りがこれを切ったときだけ延ばす */
const EXTEND_BELOW = 30 * DAY;
/** Cookie はブラウザの上限（400 日）まで持たせ、期限はサーバーの側で決める */
const COOKIE_MAX_AGE = 400 * DAY;
const PENDING_TTL = 10 * 60_000;
/** ログインの途中は 1 つのサーバーの中だけで持つ（再起動したらやり直し） */
const PENDING_MAX = 10_000;
/** 表示名の長さ（`rename` と同じ） */
const NAME_MAX = 32;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");
const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** 前段のリバースプロキシが付ける X-Forwarded-* を優先して、ブラウザから見た自分のオリジンを返す */
export function requestOrigin(req: IncomingMessage): string {
  let proto = String(req.headers["x-forwarded-proto"] ?? "http")
    .split(",")[0]
    ?.trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost")
    .split(",")[0]
    ?.trim();
  if (!host || !/^[\w.:[\]-]+$/.test(host)) return "";
  // 前段が X-Forwarded-Proto を付けないときも、ブラウザが https で来ていれば https とみなす
  if (proto !== "https" && typeof req.headers.origin === "string") {
    try {
      const browser = new URL(req.headers.origin);
      if (browser.protocol === "https:" && browser.host === host) proto = "https";
    } catch {
      // 読めない Origin は使わない
    }
  }
  return `${proto === "https" ? "https" : "http"}://${host}`;
}

/**
 * 同じオリジンからの fetch か。ブラウザは GET 以外の fetch に Origin を付ける。
 * 付いていない・違うときは、ほかのサイトからログインの Cookie を使わせない
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return typeof origin === "string" && origin === requestOrigin(req);
}

function cookie(req: IncomingMessage, name: string, value: string, maxAgeMs: number): string {
  const secure = requestOrigin(req).startsWith("https:") ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

export function normalizeName(name: string, fallback = "名無し"): string {
  return name.trim().slice(0, NAME_MAX) || fallback;
}

/** OAuth の client_id（アプリのトップページ。Misskey が読みに来て redirect_uri の link を確かめる）と戻り先 */
export const oauthClient = (origin: string) => ({
  clientId: `${origin}/`,
  redirectUri: `${origin}/api/auth/misskey/callback`,
});

interface MisskeyUser {
  id: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

const MisskeyI = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  name: z.string().nullish(),
  avatarUrl: z.string().nullish(),
});

/** 認可コードをトークンに替えて、許可した人を確かめる。トークンは本人確認にだけ使い、すぐ捨てる */
async function exchangeCode(
  misskey: string,
  origin: string,
  code: string,
  verifier: string,
): Promise<MisskeyUser | null> {
  const { clientId, redirectUri } = oauthClient(origin);
  const token = await fetch(`${misskey}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!token.ok) return null;
  const accessToken = ((await token.json()) as { access_token?: unknown }).access_token;
  if (typeof accessToken !== "string") return null;
  const res = await fetch(`${misskey}/api/i`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const parsed = MisskeyI.safeParse(await res.json());
  if (!parsed.success) return null;
  const u = parsed.data;
  // アイコンは http(s) の URL だけ受け取る（画面の img にそのまま入れるため）
  const avatarUrl = u.avatarUrl && /^https?:\/\//.test(u.avatarUrl) ? u.avatarUrl : null;
  return { id: u.id, username: u.username, name: u.name ?? null, avatarUrl };
}

export interface AuthOptions {
  /** ログインに使う Misskey のオリジン（例：https://misskey.resonite.love）。テストでは偽物を指す */
  misskeyUrl: string;
  /** 開発とテストだけ。名前だけでログインできる */
  devLogin: boolean;
  /** ログアウトしたセッションの接続を閉じる */
  onSessionEnded?: (sessionKey: string) => void;
}

export interface Identity {
  user: User;
  /** ログインのセッションのキー（トークンのハッシュ）。ログアウトで接続を閉じるのに使う */
  sessionKey: string;
}

export class Auth {
  readonly misskeyHost: string;
  private readonly misskeyUrl: string;
  private readonly pending = new Map<
    string,
    { bindHash: string; verifier: string; expiresAt: number }
  >();

  constructor(
    private readonly store: Store,
    private readonly o: AuthOptions,
  ) {
    const url = new URL(o.misskeyUrl);
    this.misskeyUrl = url.origin;
    this.misskeyHost = url.host;
  }

  get devLogin(): boolean {
    return this.o.devLogin;
  }

  /** リクエストの本人。セッションが無い・切れていれば null */
  async identify(req: IncomingMessage): Promise<Identity | null> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const sessionKey = hashToken(token);
    const found = await this.store.authSession(sessionKey);
    if (!found) return null;
    const now = Date.now();
    if (found.expiresAt <= now) return null;
    if (found.expiresAt - now < EXTEND_BELOW)
      await this.store.extendAuthSession(sessionKey, now + SESSION_TTL);
    return { user: found.user, sessionKey };
  }

  async userOf(req: IncomingMessage): Promise<User | null> {
    return (await this.identify(req))?.user ?? null;
  }

  /** そのセッションがまだ使えるか（接続を続けてよいか） */
  async sessionAlive(sessionKey: string): Promise<boolean> {
    const found = await this.store.authSession(sessionKey);
    return !!found && found.expiresAt > Date.now();
  }

  /** 期限の切れたセッションとログインの途中を消す */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const [state, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(state);
    await this.store.deleteExpiredAuthSessions(now);
  }

  private async startSession(req: IncomingMessage, user: User): Promise<string> {
    const token = newSecret();
    await this.store.createAuthSession(hashToken(token), user.id, Date.now() + SESSION_TTL);
    return cookie(req, SESSION_COOKIE, token, COOKIE_MAX_AGE);
  }

  register(app: FastifyInstance): void {
    // GET 以外の /api は、同じオリジンからの fetch だけ受ける（ログインの Cookie をほかのサイトに使わせない）
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.startsWith("/api/")) return;
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
      if (!sameOrigin(req.raw))
        return reply.code(403).send({ error: "ほかのサイトからの操作は受け付けません" });
    });

    app.get("/api/auth/me", async (req, reply) => {
      const user = await this.userOf(req.raw);
      reply.header("cache-control", "no-store");
      return {
        user: user ? userInfo(user) : null,
        misskeyHost: this.misskeyHost,
        devLogin: this.o.devLogin,
      };
    });

    app.post("/api/auth/misskey/start", async (req, reply) => {
      if (this.pending.size >= PENDING_MAX) await this.sweep();
      if (this.pending.size >= PENDING_MAX)
        return reply
          .code(503)
          .send({ error: "混み合っています。少し待ってからやり直してください" });
      const state = randomUUID();
      const bind = newSecret();
      const verifier = newSecret();
      this.pending.set(state, {
        bindHash: hashToken(bind),
        verifier,
        expiresAt: Date.now() + PENDING_TTL,
      });
      const { clientId, redirectUri } = oauthClient(requestOrigin(req.raw));
      const q = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "read:account",
        state,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
      });
      reply.header("set-cookie", cookie(req.raw, PENDING_COOKIE, bind, PENDING_TTL));
      reply.header("cache-control", "no-store");
      return { url: `${this.misskeyUrl}/oauth/authorize?${q}` };
    });

    app.get<{ Querystring: Record<string, string | undefined> }>(
      "/api/auth/misskey/callback",
      async (req, reply) => {
        const state = req.query.state ?? "";
        const pending = this.pending.get(state);
        // 1 つのログインの戻りを受けるのは一度だけ（認可コードも一度しか使えない）
        this.pending.delete(state);
        const clearPending = cookie(req.raw, PENDING_COOKIE, "", 0);
        if (!pending || pending.expiresAt <= Date.now())
          return page(
            reply,
            400,
            "ログインの手続きが見つからないか、期限が切れました。もう一度お試しください。",
            [clearPending],
          );
        // ログインを始めたブラウザでなければ入れない（他人に許可の URL を開かせて入る、を防ぐ）
        const bind = parseCookies(req.headers.cookie)[PENDING_COOKIE];
        if (!bind || hashToken(bind) !== pending.bindHash)
          return page(
            reply,
            400,
            "ログインを始めたブラウザで許可してください。Tukurium を開いたブラウザで、もう一度お試しください。",
            [clearPending],
          );
        const code = req.query.code;
        const iss = req.query.iss;
        if (!code || (iss !== undefined && iss !== this.misskeyUrl))
          return page(reply, 400, "Misskey で許可されませんでした。もう一度お試しください。", [
            clearPending,
          ]);
        let misskey: MisskeyUser | null = null;
        try {
          misskey = await exchangeCode(
            this.misskeyUrl,
            requestOrigin(req.raw),
            code,
            pending.verifier,
          );
        } catch (e) {
          req.log.warn(`Misskey への問い合わせに失敗しました: ${e}`);
        }
        if (!misskey)
          return page(
            reply,
            400,
            "Misskey で本人を確かめられませんでした。もう一度お試しください。",
            [clearPending],
          );
        const user = await this.store.loginUser({
          key: `misskey:${misskey.id}`,
          name: normalizeName(misskey.name || misskey.username),
          account: `@${misskey.username}@${this.misskeyHost}`,
          avatarUrl: misskey.avatarUrl,
        });
        const session = await this.startSession(req.raw, user);
        return reply
          .code(302)
          .header("set-cookie", [session, clearPending])
          .header("cache-control", "no-store")
          .header("location", "/")
          .send();
      },
    );

    app.post("/api/auth/dev", async (req, reply) => {
      if (!this.o.devLogin) return reply.code(404).send({ error: "not found" });
      const parsed = z.object({ name: z.string() }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "名前を入れてください" });
      const name = normalizeName(parsed.data.name, "開発者");
      const user = await this.store.loginUser({
        key: `dev:${name}`,
        name,
        account: `@${name}@dev`,
        avatarUrl: null,
      });
      reply.header("set-cookie", await this.startSession(req.raw, user));
      return { user: userInfo(user) };
    });

    app.post("/api/auth/logout", async (req, reply) => {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) {
        const sessionKey = hashToken(token);
        await this.store.deleteAuthSession(sessionKey);
        this.o.onSessionEnded?.(sessionKey);
      }
      reply.header("set-cookie", cookie(req.raw, SESSION_COOKIE, "", 0));
      return { ok: true };
    });
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Misskey から戻ってきて、うまくいかなかったときの小さな案内ページ */
function page(reply: FastifyReply, status: number, message: string, cookies: string[]) {
  return reply
    .code(status)
    .header("set-cookie", cookies)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("x-frame-options", "DENY")
    .header("content-security-policy", "frame-ancestors 'none'")
    .send(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ツクリウム</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f1ea;color:#26262e;font-family:sans-serif;text-align:center;padding:16px;box-sizing:border-box}div{max-width:480px}p{line-height:1.7}a{color:#2f5fc4}</style></head>
<body><div><p>${esc(message)}</p><p><a href="/">ツクリウムに戻る</a></p></div></body></html>`);
}
