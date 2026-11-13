import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@tukurium/shared";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../app";
import { MemoryStore } from "../store/store";

const ORIGIN = "http://localhost:80";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** 偽の Misskey。認可コード 1 つにつき 1 人。PKCE の code_verifier を確かめる */
async function fakeMisskey() {
  const codes = new Map<string, { challenge: string; user: object }>();
  const tokens = new Map<string, object>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (req.url === "/oauth/token") {
        const form = new URLSearchParams(body);
        const entry = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          !entry ||
          entry.challenge !== challenge ||
          form.get("redirect_uri") !== `${ORIGIN}/api/auth/misskey/callback`
        ) {
          res.writeHead(400).end("{}");
          return;
        }
        codes.delete(form.get("code") ?? "");
        const token = `at_${Math.random()}`;
        tokens.set(token, entry.user);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: token }));
        return;
      }
      if (req.url === "/api/i") {
        const user = tokens.get(String(req.headers.authorization).replace("Bearer ", ""));
        res.writeHead(user ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(user ?? {}));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise((r) => server.close(() => r())));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    /** 利用者が Misskey で許可した。認可コードを返す */
    approve(challenge: string, user: object) {
      const code = `c_${Math.random()}`;
      codes.set(code, { challenge, user });
      return code;
    },
  };
}

async function start(devLogin = false) {
  const misskey = await fakeMisskey();
  const store = new MemoryStore();
  const app = await buildApp(
    {
      host: "127.0.0.1",
      port: 0,
      clientDir: undefined,
      databaseUrl: undefined,
      s3: undefined,
      assetDir: await mkdtemp(join(tmpdir(), "tk-assets-")),
      gitDir: await mkdtemp(join(tmpdir(), "tk-git-")),
      misskeyUrl: misskey.url,
      devLogin,
    },
    { store },
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { app, store, misskey, wsUrl: `ws://127.0.0.1:${addr.port}/ws` };
}

const cookieOf = (setCookie: string | string[] | undefined, name: string) => {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of all) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1] ?? "";
  }
  return undefined;
};

type App = Awaited<ReturnType<typeof start>>["app"];

/** ログインを始める（ログインの画面の「Misskey でログイン」） */
async function begin(app: App) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/misskey/start",
    headers: { origin: ORIGIN },
  });
  expect(res.statusCode).toBe(200);
  const authorize = new URL(res.json().url);
  return {
    authorize,
    state: authorize.searchParams.get("state") ?? "",
    challenge: authorize.searchParams.get("code_challenge") ?? "",
    pending: cookieOf(res.headers["set-cookie"], "tukurium_login") ?? "",
  };
}

const callback = (app: App, query: Record<string, string>, pending?: string) =>
  app.inject({
    method: "GET",
    url: `/api/auth/misskey/callback?${new URLSearchParams(query)}`,
    headers: pending ? { cookie: `tukurium_login=${pending}` } : {},
  });

const me = async (app: App, session?: string) =>
  (
    await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: session ? { cookie: `tukurium_session=${session}` } : {},
    })
  ).json();

const RENI = {
  id: "9abc",
  username: "rhenium",
  name: "れにうむ",
  avatarUrl: "https://misskey.example/avatar.webp",
};

async function login(app: App, misskey: Awaited<ReturnType<typeof fakeMisskey>>, user = RENI) {
  const b = await begin(app);
  const code = misskey.approve(b.challenge, user);
  const res = await callback(app, { code, state: b.state }, b.pending);
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe("/");
  const session = cookieOf(res.headers["set-cookie"], "tukurium_session");
  if (!session) throw new Error("ログインの Cookie がありません");
  return session;
}

describe("Misskey でのログイン（ADR 0074）", () => {
  it("OAuth（PKCE）で許可した人として入る。表示名は初回だけ Misskey の名前にする", async () => {
    const { app, misskey } = await start();
    expect(await me(app)).toMatchObject({ user: null, devLogin: false });
    const b = await begin(app);
    expect(`${b.authorize.origin}${b.authorize.pathname}`).toBe(`${misskey.url}/oauth/authorize`);
    expect(Object.fromEntries(b.authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: `${ORIGIN}/`,
      redirect_uri: `${ORIGIN}/api/auth/misskey/callback`,
      scope: "read:account",
      code_challenge_method: "S256",
    });
    const session = await login(app, misskey);
    const host = new URL(misskey.url).host;
    expect((await me(app, session)).user).toMatchObject({
      name: "れにうむ",
      account: `@rhenium@${host}`,
      avatarUrl: RENI.avatarUrl,
    });

    // Tukurium で名前を変えたあとにログインし直しても、名前は残り、アイコンは新しくなる
    const ws = await connect(app, session);
    ws.send(JSON.stringify({ t: "rename", name: "rhenium" }));
    await new Promise((r) => setTimeout(r, 50));
    ws.close();
    const again = await login(app, misskey, {
      ...RENI,
      avatarUrl: "https://misskey.example/b.png",
    });
    const user = (await me(app, again)).user;
    expect(user).toMatchObject({ name: "rhenium", avatarUrl: "https://misskey.example/b.png" });
    expect(user.id).toBe((await me(app, session)).user.id);
  });

  it("ログインを始めたブラウザでなければ入れない。戻りは一度しか受けない", async () => {
    const { app, misskey } = await start();
    const b = await begin(app);
    const code = misskey.approve(b.challenge, RENI);
    // 他人に許可の URL を開かされた（待ち合わせの Cookie が無い）
    const other = await callback(app, { code, state: b.state });
    expect(other.statusCode).toBe(400);
    expect(cookieOf(other.headers["set-cookie"], "tukurium_session")).toBeUndefined();
    // その後に始めた本人が戻っても、そのログインはもう使えない
    const late = await callback(app, { code, state: b.state }, b.pending);
    expect(late.statusCode).toBe(400);
    // 拒否された・別のサーバーからの応答
    const denied = await begin(app);
    expect((await callback(app, { state: denied.state }, denied.pending)).statusCode).toBe(400);
    const wrongIss = await begin(app);
    const code2 = misskey.approve(wrongIss.challenge, RENI);
    expect(
      (
        await callback(
          app,
          { code: code2, state: wrongIss.state, iss: "https://evil.example" },
          wrongIss.pending,
        )
      ).statusCode,
    ).toBe(400);
  });

  it("ログインしていない接続は断る。ログアウトすると、そのセッションの接続を閉じる", async () => {
    const { app, misskey } = await start();
    const anon = await connect(app);
    const refused = await nextMessage(anon);
    expect(refused).toEqual({ t: "auth.required" });

    const session = await login(app, misskey);
    const ws = await connect(app, session);
    expect(await nextMessage(ws)).toMatchObject({ t: "welcome", you: { name: "れにうむ" } });
    const closed = new Promise<void>((r) => ws.once("close", () => r()));
    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: ORIGIN, cookie: `tukurium_session=${session}` },
    });
    expect(out.statusCode).toBe(200);
    await closed;
    expect((await me(app, session)).user).toBeNull();
  });

  it("hello を送るまでは、ほかの人の動きの知らせを送らない（最初に届くのは welcome）", async () => {
    const { app, misskey } = await start();
    const a = await connect(app, await login(app, misskey), undefined, false);
    const b = await connect(app, await login(app, misskey, { ...RENI, id: "other" }));
    expect(await nextMessage(b)).toMatchObject({ t: "welcome" });
    b.send(JSON.stringify({ t: "session.create", name: "部屋" }));
    await new Promise((r) => setTimeout(r, 100));
    a.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }));
    expect(await nextMessage(a)).toMatchObject({ t: "welcome" });
  });

  it("ほかのサイトの画面からの WebSocket は、ログインの Cookie があっても入れない", async () => {
    const { app, misskey } = await start();
    const session = await login(app, misskey);
    const ws = await connect(app, session, "https://evil.example");
    expect(await nextMessage(ws)).toEqual({ t: "auth.required" });
  });

  it("開発用ログインは、開いていなければ使えない", async () => {
    const closed = await start(false);
    const res = await closed.app.inject({
      method: "POST",
      url: "/api/auth/dev",
      headers: { origin: ORIGIN },
      payload: { name: "a" },
    });
    expect(res.statusCode).toBe(404);
    const open = await start(true);
    const ok = await open.app.inject({
      method: "POST",
      url: "/api/auth/dev",
      headers: { origin: ORIGIN },
      payload: { name: "a" },
    });
    expect(ok.json().user).toMatchObject({ name: "a", account: "@a@dev" });
    // 同じオリジンからでなければ受けない
    const foreign = await open.app.inject({
      method: "POST",
      url: "/api/auth/dev",
      headers: { origin: "https://evil.example" },
      payload: { name: "a" },
    });
    expect(foreign.statusCode).toBe(403);
  });
});

const sockets = new WeakMap<WebSocket, unknown[]>();

async function connect(
  app: App,
  session?: string,
  origin?: string,
  hello = true,
): Promise<WebSocket> {
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`, {
    headers: {
      ...(session ? { cookie: `tukurium_session=${session}` } : {}),
      ...(origin ? { origin } : {}),
    },
  });
  const inbox: unknown[] = [];
  sockets.set(ws, inbox);
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise<void>((r) => ws.once("open", () => r()));
  if (hello) ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }));
  return ws;
}

async function nextMessage(ws: WebSocket): Promise<unknown> {
  const inbox = sockets.get(ws) ?? [];
  for (let i = 0; i < 100; i++) {
    if (inbox.length) return inbox.shift();
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}
