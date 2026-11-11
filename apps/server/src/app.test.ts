import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProject, ProjectDoc } from "@tukurium/repo-model";
import { PROTOCOL_VERSION, type ServerMessage } from "@tukurium/shared";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { buildApp } from "./app";
import { type AssetStore, assetId } from "./assets/assetStore";
import { MemoryStore } from "./store/store";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

class MemoryAssets implements AssetStore {
  readonly items = new Map<string, { data: Buffer; contentType: string }>();
  async put(data: Buffer, contentType: string) {
    const id = assetId(data);
    this.items.set(id, { data, contentType });
    return id;
  }
  async get(id: string) {
    return this.items.get(id) ?? null;
  }
}

async function start(opts: { ownerGraceMs?: number; worldChangeMs?: number } = {}) {
  const store = new MemoryStore();
  const assets = new MemoryAssets();
  const app = await buildApp(
    {
      host: "127.0.0.1",
      port: 0,
      clientDir: undefined,
      databaseUrl: undefined,
      s3: undefined,
      assetDir: "",
      gitDir: await mkdtemp(join(tmpdir(), "tk-git-")),
    },
    {
      store,
      assets,
      hub: {
        ownerGraceMs: opts.ownerGraceMs ?? 60_000,
        saveDelayMs: 20,
        ...(opts.worldChangeMs != null ? { worldChangeMs: opts.worldChangeMs } : {}),
      },
    },
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  close = () => app.close();
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { app, store, assets, url: `ws://127.0.0.1:${addr.port}/ws` };
}

type Msg<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

async function client(url: string, name: string, token?: string) {
  const ws = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (d) => {
    inbox.push(JSON.parse(d.toString()));
    for (const w of waiters.splice(0)) w();
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  const send = (m: object) => ws.send(JSON.stringify(m));
  const next = async <T extends ServerMessage["t"]>(
    t: T,
    pred: (m: Msg<T>) => boolean = () => true,
  ): Promise<Msg<T>> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const i = inbox.findIndex((m) => m.t === t && pred(m as Msg<T>));
      if (i >= 0) return inbox.splice(i, 1)[0] as Msg<T>;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${t}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  send({ t: "hello", protocol: PROTOCOL_VERSION, name, token });
  const welcome = await next("welcome");
  return { ws, inbox, send, next, me: welcome.you, token: welcome.token };
}

const docUpdate = (fn: (d: Y.Doc) => void) => {
  const d = new Y.Doc();
  fn(d);
  return Buffer.from(Y.encodeStateAsUpdate(d)).toString("base64");
};

async function sessionWithWorkspace(url: string) {
  const a = await client(url, "れにうむ");
  a.send({ t: "session.create", name: "作業部屋" });
  const s = (await a.next("session")).session;
  a.send({
    t: "ws.create",
    name: "銃",
    initial: docUpdate((d) => d.getText("t").insert(0, "hello")),
  });
  const { workspaceId } = await a.next("ws.created");
  await a.next("ws.doc");
  const b = await client(url, "ここあ");
  b.send({ t: "session.join", sessionId: s.id });
  await b.next("session");
  return { a, b, sessionId: s.id, workspaceId };
}

const api = (app: Awaited<ReturnType<typeof start>>["app"], token: string) => ({
  get: (url: string) => app.inject({ method: "GET", url, headers: { "x-tukurium-token": token } }),
  post: (url: string, payload: object = {}) =>
    app.inject({ method: "POST", url, payload, headers: { "x-tukurium-token": token } }),
  patch: (url: string, payload: object) =>
    app.inject({ method: "PATCH", url, payload, headers: { "x-tukurium-token": token } }),
});

describe("本人識別とセッション", () => {
  it("取り込み元の中身は、フォークできる人にだけ渡す", async () => {
    const { app, url } = await start();
    const owner = await client(url, "作者");
    const other = await client(url, "ほかの人");
    const A = api(app, owner.token);
    const B = api(app, other.token);
    const source = (
      await A.post("/api/repos", { name: "銃と的", template: "sample", visibility: "private" })
    ).json();
    const mine = await A.get(`/api/repos/${source.id}/import-source`);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().snapshot.kokostates.length).toBeGreaterThan(0);
    expect(mine.json().commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await B.get(`/api/repos/${source.id}/import-source`)).statusCode).toBe(403);
    await A.patch(`/api/repos/${source.id}`, { visibility: "public" });
    expect((await B.get(`/api/repos/${source.id}/import-source`)).statusCode).toBe(200);
  });
  it("未編集の既存先へ同時に抽出しても、両方の取り込みを残す (#62)", async () => {
    const { app, url } = await start();
    const user = await client(url, "作者");
    const A = api(app, user.token);
    const source = (await A.post("/api/repos", { name: "銃と的", template: "sample" })).json();
    const target = (await A.post("/api/repos", { name: "取り込み先", template: "empty" })).json();
    const responses = await Promise.all(
      ["ks_gun", "ks_target"].map((koko) =>
        A.post(`/api/repos/${source.id}/extract`, {
          selection: { kokostates: [koko] },
          target: { repoId: target.id },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    const snapshot = (await A.get(`/api/repos/${target.id}/snapshot`)).json();
    expect(snapshot.kokostates.map((k: { name: string }) => k.name).sort()).toEqual([
      "Gun",
      "Target",
    ]);
  });
  it("開いている取り込み先には抽出せず、新規の抽出は利用できる (#62)", async () => {
    const { app, url } = await start();
    const user = await client(url, "作者");
    const A = api(app, user.token);
    const source = (await A.post("/api/repos", { name: "銃", template: "gun" })).json();
    const target = (await A.post("/api/repos", { name: "取り込み先", template: "empty" })).json();
    user.send({ t: "session.create", name: "編集中" });
    await user.next("session");
    user.send({ t: "ws.openRepo", repoId: target.id });
    await user.next("ws.created");
    await user.next("ws.doc");
    const result = await A.post(`/api/repos/${source.id}/extract`, {
      selection: { kokostates: ["ks_gun"] },
      target: { repoId: target.id },
    });
    expect(result.statusCode).toBe(409);
    const fresh = await A.post(`/api/repos/${source.id}/extract`, {
      selection: { kokostates: ["ks_gun"] },
      target: { name: "抽出した銃" },
    });
    expect(fresh.statusCode).toBe(200);
    expect(
      (await A.get(`/api/repos/${fresh.json().repo.id}/snapshot`)).json().kokostates,
    ).toHaveLength(1);
  });
  it("自動保存がある既存先への抽出で、次の編集コミットから取り込み内容を失わない (#62)", async () => {
    const { app, url, store } = await start();
    const user = await client(url, "作者");
    const A = api(app, user.token);
    const source = (await A.post("/api/repos", { name: "銃", template: "gun" })).json();
    const target = (await A.post("/api/repos", { name: "取り込み先", template: "empty" })).json();
    const workspaceId = `w_${target.id}`;
    const draft = new ProjectDoc();
    draft.load(emptyProject("取り込み先"));
    draft.addEntity({ output: "out_main", name: "未コミットの箱" });
    const saved = Y.encodeStateAsUpdate(draft.doc);
    await store.saveDoc(workspaceId, saved);
    const initialCommits = (await A.get(`/api/repos/${target.id}/commits`)).json();
    const extracted = await A.post(`/api/repos/${source.id}/extract`, {
      selection: { kokostates: ["ks_gun"] },
      target: { repoId: target.id },
    });
    if (extracted.statusCode === 409) {
      expect(extracted.json().error).toMatch(/新しいプロジェクト/);
      expect(await store.loadDoc(workspaceId)).toEqual(saved);
      expect((await A.get(`/api/repos/${target.id}/commits`)).json()).toEqual(initialCommits);
      return;
    }
    expect(extracted.statusCode).toBe(200);
    expect((await A.get(`/api/repos/${target.id}/snapshot`)).json().kokostates).toHaveLength(1);
    user.send({ t: "session.create", name: "確認" });
    await user.next("session");
    user.send({ t: "ws.openRepo", repoId: target.id });
    await user.next("ws.created");
    const opened = new ProjectDoc();
    Y.applyUpdate(opened.doc, Buffer.from((await user.next("ws.doc")).update, "base64"));
    user.send({ t: "ws.commit", workspaceId, message: "抽出後の保存" });
    await user.next("ws.committed");
    expect((await A.get(`/api/repos/${target.id}/snapshot`)).json().kokostates).toHaveLength(1);
    expect(opened.snapshot().kokostates).toHaveLength(1);
    expect(opened.entities().some((e) => e.name === "未コミットの箱")).toBe(true);
  });
  it("フレンドへの招待は受信者だけが応答し、受け取るだけでは移動しない", async () => {
    const { app, url, store } = await start();
    const a = await client(url, "招待する人"),
      b = await client(url, "受け取る人"),
      c = await client(url, "第三者");
    const A = api(app, a.token),
      B = api(app, b.token),
      C = api(app, c.token);
    a.send({ t: "session.create", name: "招待先" });
    const sid = (await a.next("session")).session.id;
    expect((await A.post("/api/me/invitations", { to: b.me.id, sessionId: sid })).statusCode).toBe(
      403,
    );
    await A.post(`/api/me/friends/${b.me.id}/request`);
    await B.post(`/api/me/friends/${a.me.id}/accept`);
    const invite = (await A.post("/api/me/invitations", { to: b.me.id, sessionId: sid })).json();
    expect((await A.post("/api/me/invitations", { to: b.me.id, sessionId: sid })).json().id).toBe(
      invite.id,
    );
    expect(
      (await A.post(`/api/me/invitations/${invite.id}/respond`, { action: "accept" })).statusCode,
    ).toBe(403);
    expect(
      (await C.post(`/api/me/invitations/${invite.id}/respond`, { action: "decline" })).statusCode,
    ).toBe(403);
    expect((await B.get("/api/me/social")).json().invitations.incoming[0]).toMatchObject({
      id: invite.id,
      status: "pending",
    });
    expect(
      (await B.post(`/api/me/invitations/${invite.id}/respond`, { action: "accept" })).json()
        .status,
    ).toBe("accepted");
    expect((await A.get("/api/me/social")).json().friends[0].presence.sessions).toEqual([]);
    const next = (await A.post("/api/me/invitations", { to: b.me.id, sessionId: sid })).json();
    await B.post(`/api/me/invitations/${next.id}/respond`, { action: "decline" });
    expect(
      (await B.post(`/api/me/invitations/${next.id}/respond`, { action: "accept" })).statusCode,
    ).toBe(409);
    const expired = await store.createInvitation({
      id: "expired-invite",
      from: a.me.id,
      to: b.me.id,
      sessionId: sid,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(
      (await B.post(`/api/me/invitations/${expired.id}/respond`, { action: "accept" })).statusCode,
    ).toBe(409);
    const closed = (await A.post("/api/me/invitations", { to: b.me.id, sessionId: sid })).json();
    a.send({ t: "session.close" });
    await a.next("session.closed");
    expect(
      (await B.post(`/api/me/invitations/${closed.id}/respond`, { action: "accept" })).statusCode,
    ).toBe(409);
    expect((await B.get("/api/me/social")).json().invitations.incoming[0].status).toBe("expired");
  });

  it("申請の受け手が承認した相手だけに状態を返し、解除と複数接続を反映する", async () => {
    const { app, url } = await start();
    const a = await client(url, "申請する人"),
      b = await client(url, "承認する人"),
      c = await client(url, "第三者");
    const A = api(app, a.token),
      B = api(app, b.token),
      C = api(app, c.token);
    expect((await app.inject({ method: "GET", url: "/api/me/social" })).statusCode).toBe(401);
    expect((await B.get("/api/me/social")).json().profile).toEqual({
      availability: "online",
      note: "",
    });
    expect((await A.post(`/api/me/friends/${a.me.id}/request`)).statusCode).toBe(400);
    await A.post(`/api/me/friends/${b.me.id}/request`);
    await A.post(`/api/me/friends/${b.me.id}/request`);
    expect((await B.get("/api/me/social")).json()).toMatchObject({
      friends: [],
      incoming: [{ user: { id: a.me.id } }],
    });
    expect((await A.post(`/api/me/friends/${b.me.id}/accept`)).statusCode).toBe(409);
    expect((await C.post(`/api/me/friends/${a.me.id}/accept`)).statusCode).toBe(409);
    expect((await B.post(`/api/me/friends/${a.me.id}/accept`)).statusCode).toBe(200);
    await B.patch("/api/me/social", { availability: "busy", note: "制作中です" });
    const info = (await A.get("/api/me/social")).json();
    expect(info.friends[0]).toMatchObject({
      user: { id: b.me.id },
      profile: { availability: "busy", note: "制作中です" },
      presence: { online: true },
    });
    expect((await C.get("/api/me/social")).json().friends).toEqual([]);
    for (const availability of ["online", "joinable", "ask", "busy"]) {
      const profile = { availability, note: "ひとやすみ" };
      expect((await B.patch("/api/me/social", profile)).statusCode).toBe(200);
      expect((await B.get("/api/me/social")).json().profile).toEqual(profile);
      expect((await A.get("/api/me/social")).json().friends[0].profile).toEqual(profile);
    }
    expect(
      (await B.patch("/api/me/social", { availability: "unknown", note: "" })).statusCode,
    ).toBe(400);
    const tab = await client(url, "承認する人", b.token);
    b.ws.close();
    await expect
      .poll(async () => (await A.get("/api/me/social")).json().friends[0].presence.online)
      .toBe(true);
    tab.send({ t: "session.create", name: "フレンドの場所" });
    const sid = (await tab.next("session")).session.id;
    await expect
      .poll(async () =>
        (await A.get("/api/me/social"))
          .json()
          .friends[0].presence.sessions.map((s: { id: string }) => s.id),
      )
      .toEqual([sid]);
    expect(
      (await A.get(`/api/people?q=${encodeURIComponent("承認する人")}`)).json()[0],
    ).toMatchObject({ relation: "friend" });
    await app.inject({
      method: "DELETE",
      url: `/api/me/friends/${b.me.id}`,
      headers: { "x-tukurium-token": a.token },
    });
    expect((await A.get("/api/me/social")).json().friends).toEqual([]);
    expect((await api(app, tab.token).get("/api/me/social")).json().friends).toEqual([]);
  });

  it("アイテムを検索し、入手した版を本人の所持一覧へ固定する", async () => {
    const { app, url } = await start();
    const owner = await client(url, "アイテム作者");
    const buyer = await client(url, "使う人");
    const A = api(app, owner.token);
    const B = api(app, buyer.token);
    const repo = (
      await A.post("/api/repos", { name: "検索用の銃", kind: "item", template: "gun" })
    ).json();
    const work = (await A.post("/api/works", { repoId: repo.id, outputId: "out_gun" })).json();
    const r1 = (await A.post(`/api/works/${work.id}/releases`)).json();
    const r2 = (await A.post(`/api/works/${work.id}/releases`)).json();
    const secondRepo = (
      await A.post("/api/repos", { name: "別の銃", kind: "item", template: "gun" })
    ).json();
    const secondWork = (
      await A.post("/api/works", { repoId: secondRepo.id, outputId: "out_gun" })
    ).json();
    const secondRelease = (await A.post(`/api/works/${secondWork.id}/releases`)).json();
    const worldRepo = (
      await A.post("/api/repos", { name: "ワールド", kind: "world", template: "empty" })
    ).json();
    const worldWork = (
      await A.post("/api/works", { repoId: worldRepo.id, outputId: "out_main" })
    ).json();
    const worldRelease = (await A.post(`/api/works/${worldWork.id}/releases`)).json();
    const detail = (await B.get(`/api/works/${work.id}`)).json();
    expect(detail.project).toEqual({ id: repo.id, name: "検索用の銃" });
    expect(detail.releases.map((release: { version: number }) => release.version)).toEqual([2, 1]);
    expect(detail.releases[0].comment).toBe("最初のコミット");
    expect((await B.get(`/api/works/${worldWork.id}`)).json()).toMatchObject({
      outputKind: "world",
      project: { id: worldRepo.id, name: "ワールド" },
    });
    expect(
      (await app.inject({ method: "GET", url: `/api/works/${work.id}` })).json().project,
    ).toEqual({ id: repo.id, name: "検索用の銃" });
    expect((await B.get("/api/works/missing")).statusCode).toBe(404);
    expect((await A.get(`/api/works?owner=${owner.me.id}`)).json()).toHaveLength(3);
    await A.patch(`/api/repos/${repo.id}`, { visibility: "private" });
    expect((await B.get(`/api/works/${work.id}`)).json().project).toBeNull();
    expect((await A.get(`/api/works/${work.id}`)).json().project).toBeNull();
    await A.patch(`/api/repos/${repo.id}`, { visibility: "public" });
    expect(
      (await B.get(`/api/market?q=${encodeURIComponent("アイテム作者")}&limit=1`)).json(),
    ).toMatchObject({ total: 2, items: [{ id: secondWork.id }], nextOffset: 1 });
    expect(
      (await B.get(`/api/market?q=${encodeURIComponent("アイテム作者")}&limit=1&offset=1`)).json(),
    ).toMatchObject({ total: 2, items: [{ id: work.id }], nextOffset: null });
    expect((await B.get("/api/market?q=nonexistent")).json().items).toEqual([]);
    expect((await B.get("/api/market?limit=49")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/me/items" })).statusCode).toBe(401);
    const item = (await B.post(`/api/me/items/${work.id}`, { releaseId: r1.id })).json();
    expect(item).toMatchObject({ userId: buyer.me.id, releaseId: r1.id, available: true });
    expect((await B.post(`/api/me/items/${work.id}`, { releaseId: r2.id })).json().releaseId).toBe(
      r1.id,
    );
    expect((await B.get("/api/me/items")).json()).toHaveLength(1);
    expect((await A.get("/api/me/items")).json()).toEqual([]);
    expect((await B.post(`/api/me/items/${work.id}`, { releaseId: "missing" })).statusCode).toBe(
      404,
    );
    expect(
      (await B.post(`/api/me/items/${work.id}`, { releaseId: secondRelease.id })).statusCode,
    ).toBe(404);
    expect(
      (await B.post(`/api/me/items/${worldWork.id}`, { releaseId: worldRelease.id })).statusCode,
    ).toBe(400);
    await A.patch(`/api/works/${work.id}`, { perms: { use: false } });
    expect((await B.get("/api/me/items")).json()[0]).toMatchObject({
      available: false,
      releaseId: r1.id,
    });
    expect((await B.post(`/api/me/items/${work.id}`, { releaseId: r1.id })).statusCode).toBe(403);
    await A.patch(`/api/works/${work.id}`, { perms: { use: false, view: false, fork: false } });
    expect((await B.get(`/api/works/${work.id}`)).statusCode).toBe(404);
    expect((await A.get(`/api/works/${work.id}`)).statusCode).toBe(200);
  });

  it("取り出しの再送と同じ人の別接続を一回の配置にまとめ、移動先と権限を確かめる", async () => {
    const { app, url } = await start();
    const a = await client(url, "作者");
    const b = await client(url, "利用者");
    const A = api(app, a.token);
    const repo = (await A.post("/api/repos", { name: "銃", kind: "item", template: "gun" })).json();
    const work = (await A.post("/api/works", { repoId: repo.id, outputId: "out_gun" })).json();
    const release = (await A.post(`/api/works/${work.id}/releases`)).json();
    a.send({ t: "session.create", name: "取り出し先" });
    const sid = (await a.next("session")).session.id;
    b.send({ t: "session.join", sessionId: sid });
    await b.next("session");
    const tab = await client(url, "利用者", b.token);
    tab.send({ t: "session.join", sessionId: sid });
    await tab.next("session");
    const request = {
      t: "placeRelease",
      releaseId: release.id,
      position: [0, 0, 0],
      yaw: 0,
      sessionId: sid,
      requestId: "same",
    };
    b.send(request);
    tab.send(request);
    const first = await b.next("placement.result");
    expect(first.error).toBeNull();
    expect(await tab.next("placement.result")).toEqual(first);
    b.send(request);
    expect(await b.next("placement.result")).toEqual(first);
    b.send({ ...request, position: [1, 0, 0] });
    expect((await b.next("placement.result")).error).toMatch(/要求ID/);
    b.send({ ...request, sessionId: "other", requestId: "wrong-place" });
    expect((await b.next("placement.result")).error).toMatch(/セッション/);
    await A.patch(`/api/works/${work.id}`, { perms: { use: false } });
    b.send({ ...request, requestId: "revoked" });
    expect((await b.next("placement.result")).error).toMatch(/権限/);
    b.send({ t: "session.join", sessionId: sid });
    expect(
      (await b.next("session", (m) => m.session.placements.length === 1)).session.placements,
    ).toHaveLength(1);
  });

  it("参加中にも一覧を更新し、複数タブを同じ参加者として数える", async () => {
    const { url } = await start();
    const a = await client(url, "持ち主");
    a.send({ t: "session.create", name: "一覧確認" });
    const sid = (await a.next("session")).session.id;
    const b = await client(url, "参加者");
    b.send({ t: "session.join", sessionId: sid });
    await b.next("session");
    const list = await a.next("sessions", (m) => m.sessions[0]?.count === 2);
    expect(list.sessions[0]?.participants.map((p) => p.name).sort()).toEqual(["参加者", "持ち主"]);
    const tab = await client(url, "参加者", b.token);
    tab.send({ t: "session.join", sessionId: sid });
    await tab.next("session");
    a.send({ t: "sessions.list" });
    expect(
      (await a.next("sessions", (m) => m.sessions[0]?.count === 2)).sessions[0]?.participants,
    ).toHaveLength(2);
    b.ws.close();
    a.send({ t: "sessions.list" });
    expect(
      (await a.next("sessions", (m) => m.sessions[0]?.count === 2)).sessions[0]?.participants,
    ).toHaveLength(2);
  });

  it("存在しない移動先を拒んでも現在のセッションを維持する", async () => {
    const { url } = await start();
    const a = await client(url, "持ち主");
    a.send({ t: "session.create", name: "残る部屋", requestId: "create-1" });
    const s = (await a.next("session")).session;
    expect(await a.next("session.entered")).toMatchObject({
      sessionId: s.id,
      requestId: "create-1",
    });
    a.send({ t: "session.join", sessionId: "missing", requestId: "join-1" });
    expect(await a.next("session.rejected")).toMatchObject({
      sessionId: "missing",
      requestId: "join-1",
    });
    a.send({ t: "sessions.list" });
    expect((await a.next("sessions", (m) => m.sessions[0]?.count === 1)).sessions[0]?.id).toBe(
      s.id,
    );
    expect(a.inbox.some((m) => m.t === "session.closed")).toBe(false);
  });

  it("health", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
  });

  it("トークンで同じ人として再接続できる", async () => {
    const { url } = await start();
    const a = await client(url, "れにうむ");
    a.ws.close();
    const again = await client(url, "れにうむ2", a.token);
    expect(again.me.id).toBe(a.me.id);
    expect(again.me.name).toBe("れにうむ2");
    const other = await client(url, "ここあ");
    expect(other.me.id).not.toBe(a.me.id);
  });

  it("セッションを作って参加し、位置を中継する。一覧に出る", async () => {
    const { url } = await start();
    const a = await client(url, "a");
    const watcher = await client(url, "w");
    a.send({ t: "session.create", name: "部屋" });
    const s = (await a.next("session")).session;
    const list = await watcher.next("sessions", (m) => m.sessions.length === 1);
    expect(list.sessions[0]).toMatchObject({ id: s.id, name: "部屋", count: 1 });

    const b = await client(url, "b");
    b.send({ t: "session.join", sessionId: s.id });
    const joined = await b.next("session");
    expect(joined.session.participants.map((p) => p.name).sort()).toEqual(["a", "b"]);
    await a.next("joined");
    a.send({ t: "pose", position: [1, 2, 3], yaw: 0.5, pitch: 0 });
    expect(await b.next("pose")).toMatchObject({ id: a.me.id, position: [1, 2, 3] });
  });

  it("持ち主が抜けると、猶予のあとセッションが閉じる。猶予中に戻れば続く", async () => {
    const { url } = await start({ ownerGraceMs: 150 });
    const a = await client(url, "a");
    a.send({ t: "session.create", name: "部屋" });
    const s = (await a.next("session")).session;
    const b = await client(url, "b");
    b.send({ t: "session.join", sessionId: s.id });
    await b.next("session");

    // 猶予中に戻る
    a.ws.close();
    const a2 = await client(url, "a", a.token);
    a2.send({ t: "session.join", sessionId: s.id });
    await a2.next("session");
    await new Promise((r) => setTimeout(r, 250));
    expect(b.inbox.some((m) => m.t === "session.closed")).toBe(false);

    // 戻らない
    a2.ws.close();
    expect((await b.next("session.closed")).reason).toMatch(/持ち主/);
  });

  it("持ち主はセッションを閉じられる。ほかの人は閉じられない", async () => {
    const { url } = await start();
    const { a, b } = await sessionWithWorkspace(url);
    b.send({ t: "session.close" });
    await new Promise((r) => setTimeout(r, 100));
    expect(a.inbox.some((m) => m.t === "session.closed")).toBe(false);
    a.send({ t: "session.close" });
    await b.next("session.closed");
  });
});

describe("ワークスペース", () => {
  it("既定の権限（共同編集）で参加し、互いの変更が届く", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    b.send({ t: "ws.open", workspaceId });
    const doc = await b.next("ws.doc");
    expect(doc.role).toBe("editor");
    const bd = new Y.Doc();
    Y.applyUpdate(bd, Buffer.from(doc.update, "base64"));
    expect(bd.getText("t").toString()).toBe("hello");

    // b の変更が a に届く
    const before = Y.encodeStateVector(bd);
    bd.getText("t").insert(5, " world");
    b.send({
      t: "ws.update",
      workspaceId,
      update: Buffer.from(Y.encodeStateAsUpdate(bd, before)).toString("base64"),
    });
    const upd = await a.next("ws.update");
    expect(upd.workspaceId).toBe(workspaceId);
  });

  it("閲覧者は書けない。非公開にすると新しい人は開けない", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    a.send({ t: "ws.open", workspaceId });
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");
    a.send({ t: "ws.setRole", workspaceId, userId: b.me.id, role: "viewer" });
    expect((await b.next("ws.role")).role).toBe("viewer");
    b.send({
      t: "ws.update",
      workspaceId,
      update: docUpdate((d) => d.getText("t").insert(0, "x")),
    });
    expect((await b.next("error")).message).toMatch(/権限/);

    a.send({ t: "ws.setDefaultRole", workspaceId, role: null });
    await a.next("session", (m) => m.session.workspaces[0]?.defaultRole === null);
    const c = await client(url, "c");
    c.send({
      t: "session.join",
      sessionId: a.inbox.length >= 0 ? (await a.next("session")).session.id : "",
    });
    await c.next("session");
    c.send({ t: "ws.open", workspaceId });
    expect((await c.next("ws.denied")).reason).toMatch(/非公開/);
  });

  it("権限を外すと閲覧できなくなる。管理者がいなくなる変更は拒む", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");
    a.send({ t: "ws.setRole", workspaceId, userId: a.me.id, role: "editor" });
    expect((await a.next("error")).message).toMatch(/管理者/);
    // 非公開にしてから b を外すと、b は閲覧できなくなり、更新も届かない
    a.send({ t: "ws.setDefaultRole", workspaceId, role: null });
    a.send({ t: "ws.setRole", workspaceId, userId: b.me.id, role: null });
    expect((await b.next("ws.role")).role).toBeNull();
    a.send({
      t: "ws.update",
      workspaceId,
      update: docUpdate((d) => d.getText("t").insert(0, "secret")),
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(b.inbox.some((m) => m.t === "ws.update")).toBe(false);
  });

  it("作業内容を自動保存する", async () => {
    const { url, store } = await start();
    const { a, workspaceId } = await sessionWithWorkspace(url);
    a.send({
      t: "ws.update",
      workspaceId,
      update: docUpdate((d) => d.getText("t").insert(0, "saved ")),
    });
    await new Promise((r) => setTimeout(r, 120));
    const saved = await store.loadDoc(workspaceId);
    const d = new Y.Doc();
    Y.applyUpdate(d, saved as Uint8Array);
    expect(d.getText("t").toString()).toContain("saved");
  });

  it("パネルの内容は、閲覧権限がある人にだけ見せる", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    const panel = {
      id: "insp",
      title: "Inspector · Gun",
      workspaceId,
      mode: "2d" as const,
      transform: null,
      size: { width: 420, height: 280 },
      screen: { x: 300, y: 200, viewWidth: 1280, viewHeight: 720 },
      lines: ["ammo 12"],
    };
    a.send({ t: "panels", panels: [panel] });
    expect((await b.next("panels", (m) => m.panels.length > 0)).panels[0]).toMatchObject({
      title: "Inspector · Gun",
      restricted: false,
    });
    a.send({ t: "ws.setDefaultRole", workspaceId, role: null });
    a.send({ t: "ws.setRole", workspaceId, userId: b.me.id, role: null });
    const hidden = await b.next("panels", (m) => m.panels[0]?.restricted === true);
    expect(hidden.panels[0]).toMatchObject({ title: "作業中", lines: [], restricted: true });
  });

  it("出てもワークスペースは残り、管理でない人は閉じられない", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");
    await a.next(
      "session",
      (m) => m.session.workspaces.find((w) => w.id === workspaceId)?.present.length === 2,
    );
    for (let i = a.inbox.length - 1; i >= 0; i--)
      if (a.inbox[i]?.t === "session") a.inbox.splice(i, 1);
    b.send({ t: "ws.close", workspaceId });
    const stayed = await a.next(
      "session",
      (m) => m.session.workspaces.find((w) => w.id === workspaceId)?.present.length === 1,
    );
    expect(stayed.session.workspaces.map((w) => w.id)).toContain(workspaceId);
    b.send({ t: "ws.end", workspaceId });
    expect((await b.next("error")).message).toMatch(/管理/);
    await new Promise((r) => setTimeout(r, 40));
    expect(a.inbox.some((m) => m.t === "ws.ended")).toBe(false);
  });

  it("管理者が閉じると一覧から消え、開いていた人は出る。プロジェクトは残る", async () => {
    const { url, store } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");
    const listed = await a.next("session", (m) =>
      m.session.workspaces.some((w) => w.id === workspaceId),
    );
    const repoId = listed.session.workspaces.find((w) => w.id === workspaceId)?.repoId;
    expect(repoId).toBeTruthy();
    a.send({
      t: "ws.update",
      workspaceId,
      update: docUpdate((d) => d.getText("t").insert(0, "keep ")),
    });
    a.send({ t: "ws.end", workspaceId });
    expect((await b.next("ws.ended")).reason).toMatch(/閉じました/);
    expect(
      (await b.next("session", (m) => m.session.workspaces.length === 0)).session.workspaces,
    ).toEqual([]);
    expect((await a.next("ws.ended")).workspaceId).toBe(workspaceId);
    const saved = await store.loadDoc(workspaceId);
    const d = new Y.Doc();
    Y.applyUpdate(d, saved as Uint8Array);
    expect(d.getText("t").toString()).toContain("keep");
    a.send({ t: "ws.openRepo", repoId: repoId as string });
    expect((await a.next("ws.created")).workspaceId).toBe(workspaceId);
    await a.next("ws.doc");
  });
});

describe("ワークスペースのホストと共有再生", () => {
  const frame = (mode: "play" | "edit", time = 1) => ({
    mode,
    outputId: "out",
    time,
    world: { entities: [] },
    names: {},
    status: [],
    partEntities: {},
  });

  it("作った人がホスト。他の人の操作と入力はホストへ、ホストの状態は他の人へ届く", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    expect((await a.next("ws.host")).workspaceId).toBe(workspaceId);
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");

    b.send({ t: "ws.cmd", workspaceId, cmd: "play", outputId: "out" });
    expect(await a.next("ws.cmd")).toMatchObject({ cmd: "play", from: b.me.id });
    a.send({ t: "ws.frame", workspaceId, frame: frame("play") });
    expect((await b.next("ws.frame")).frame.mode).toBe("play");
    const input = {
      action: "fire",
      phase: "down",
      origin: [0, 1, 0],
      direction: [0, 0, -1],
      player: b.me.id,
    };
    b.send({ t: "ws.input", workspaceId, input });
    expect((await a.next("ws.input")).input.action).toBe("fire");

    // ホスト以外の状態は受け付けない
    b.send({ t: "ws.frame", workspaceId, frame: frame("play", 99) });
    await new Promise((r) => setTimeout(r, 80));
    expect(a.inbox.some((m) => m.t === "ws.frame")).toBe(false);
  });

  it("ホストが抜けたら、管理権限を持つ人が最後の状態から引き継ぐ", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    await a.next("ws.host");
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");
    a.send({ t: "ws.setRole", workspaceId, userId: b.me.id, role: "admin" });
    await b.next("ws.role");
    const partEntities = { workspace: ["original", "rt:1"] };
    a.send({ t: "ws.frame", workspaceId, frame: { ...frame("play", 3.5), partEntities } });
    await b.next("ws.frame");
    a.ws.close();
    const host = await b.next("ws.host");
    expect(host.resume?.time).toBe(3.5);
    expect(host.resume?.partEntities).toEqual(partEntities);
  });

  it("引き継げる人がいなければ再生を止める", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    await a.next("ws.host");
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");
    a.send({ t: "ws.frame", workspaceId, frame: frame("play") });
    await b.next("ws.frame");
    a.send({ t: "ws.close", workspaceId });
    expect((await b.next("ws.frame", (m) => m.frame.mode === "edit")).frame.mode).toBe("edit");
    expect((await b.next("ws.log")).message).toMatch(/管理権限/);
  });
});

describe("セッションの世界（配置・適用）", () => {
  const snap = (marker: string) => ({ marker, outputs: [{ id: "out", name: "銃" }] });

  it("持ち主がセッションのホスト。配置・適用・入力はホストへ、世界の状態は全員へ", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    const hostMsg = await a.next("session.host");
    expect(hostMsg.parts).toEqual([]);
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");

    b.send({
      t: "place",
      workspaceId,
      outputId: "out",
      snapshot: snap("v1"),
      position: [1, 0, 2],
      yaw: 0,
    });
    const add = await a.next("host.addPart");
    expect(add.part).toMatchObject({ realm: workspaceId, outputId: "out", position: [1, 0, 2] });
    const info = await b.next("session", (m) => m.session.placements.length === 1);
    expect(info.session.placements[0]).toMatchObject({
      workspaceName: "銃",
      outputName: "銃",
      placedBy: b.me.id,
    });
    expect(info.session.host).toBe(a.me.id);

    b.send({ t: "apply", workspaceId, outputId: "out", snapshot: snap("v2") });
    const applied = await a.next("host.apply");
    expect(applied).toMatchObject({ realm: workspaceId, outputId: "out", by: "ここあ" });
    expect((applied.snapshot as { marker: string }).marker).toBe("v2");

    b.send({
      t: "session.input",
      input: {
        action: "fire",
        phase: "down",
        origin: [0, 0, 0],
        direction: [0, 0, -1],
        player: "b",
      },
    });
    expect((await a.next("host.input")).input.action).toBe("fire");

    const frame = {
      time: 1,
      world: { entities: [] },
      names: {},
      materials: [],
      status: [],
      partEntities: {},
    };
    a.send({ t: "session.frame", frame });
    expect((await b.next("session.frame")).frame.time).toBe(1);
    // ホスト以外の世界の状態は受け付けない
    b.send({ t: "session.frame", frame: { ...frame, time: 9 } });
    await new Promise((r) => setTimeout(r, 80));
    expect(a.inbox.some((m) => m.t === "session.frame")).toBe(false);
  });

  it("置いた物への付与を台帳に持つ（最初は null＝宣言どおり）。置いた人が変えるとホストに届く", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    await a.next("session.host");
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");
    b.send({
      t: "place",
      workspaceId,
      outputId: "out",
      snapshot: snap("v1"),
      position: [0, 0, 0],
      yaw: 0,
    });
    const add = await a.next("host.addPart");
    expect(add.part.grants).toBeNull();
    const info = await b.next("session", (m) => m.session.placements.length === 1);
    const pid = info.session.placements[0]?.id ?? "";
    expect(info.session.placements[0]?.grants).toBeNull();

    b.send({ t: "setGrants", placementId: pid, grants: ["physics.raycast"] });
    const set = await a.next("host.setGrants");
    expect(set).toMatchObject({ id: pid, grants: ["physics.raycast"] });
    const after = await b.next("session", (m) => m.session.placements[0]?.grants?.length === 1);
    expect(after.session.placements[0]?.grants).toEqual(["physics.raycast"]);
  });

  it("出していないアウトプットは適用できない。壊れた制作データは拒む。閲覧者は出せない", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    a.send({ t: "apply", workspaceId, outputId: "out", snapshot: snap("v") });
    expect((await a.next("error")).message).toMatch(/出ていません/);
    a.send({
      t: "place",
      workspaceId,
      outputId: "nope",
      snapshot: snap("v"),
      position: [0, 0, 0],
      yaw: 0,
    });
    expect((await a.next("error")).message).toMatch(/壊れて/);
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");
    a.send({ t: "ws.setRole", workspaceId, userId: b.me.id, role: "viewer" });
    await b.next("ws.role");
    b.send({
      t: "place",
      workspaceId,
      outputId: "out",
      snapshot: snap("v"),
      position: [0, 0, 0],
      yaw: 0,
    });
    expect((await b.next("error")).message).toMatch(/共同編集/);
  });

  it("持ち主が戻ると、いまの配置と最後の状態を受け取ってホストに戻る。リセットと削除も中継する", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    await a.next("session.host");
    a.send({
      t: "place",
      workspaceId,
      outputId: "out",
      snapshot: snap("v1"),
      position: [0, 0, 0],
      yaw: 0,
    });
    await a.next("host.addPart");
    const frame = {
      time: 4.2,
      world: { entities: [] },
      names: {},
      materials: [],
      status: [],
      partEntities: { placement: ["placement/original", "rt:1"] },
    };
    a.send({ t: "session.frame", frame });
    await b.next("session.frame");
    const pid = (await b.next("session", (m) => m.session.placements.length === 1)).session
      .placements[0]?.id as string;

    a.ws.close();
    await b.next("session", (m) => m.session.host === null);
    const a2 = await client(url, "れにうむ", a.token);
    a2.send({ t: "session.join", sessionId: (await b.next("session")).session.id });
    const host = await a2.next("session.host");
    expect(host.parts.map((p) => p.id)).toEqual([pid]);
    expect(host.resume?.time).toBe(4.2);
    expect(host.resume?.partEntities).toEqual(frame.partEntities);

    a2.send({ t: "resetPart", placementId: pid });
    expect((await a2.next("host.resetPart")).id).toBe(pid);
    a2.send({ t: "unplace", placementId: pid });
    expect((await a2.next("host.removePart")).id).toBe(pid);
  });
});

describe("素材", () => {
  it("本人確認できればアップロードでき、ID（SHA-256）で取り出せる", async () => {
    const { app, url } = await start();
    const a = await client(url, "a");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const up = await app.inject({
      method: "POST",
      url: "/api/assets",
      headers: { "content-type": "image/png", "x-tukurium-token": a.token },
      payload: png,
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ id: assetId(png), kind: "image", size: png.length });
    const get = await app.inject({
      method: "GET",
      url: `/api/assets/${assetId(png)}?t=${a.token}`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.rawPayload.equals(png)).toBe(true);
  });

  it("本人確認できない・対応していない種類・存在しない ID を拒む", async () => {
    const { app, url } = await start();
    const a = await client(url, "a");
    const noAuth = await app.inject({
      method: "POST",
      url: "/api/assets",
      headers: { "content-type": "image/png" },
      payload: Buffer.from([1]),
    });
    expect(noAuth.statusCode).toBe(401);
    const bad = await app.inject({
      method: "POST",
      url: "/api/assets",
      headers: { "content-type": "application/x-sh", "x-tukurium-token": a.token },
      payload: Buffer.from("echo hi"),
    });
    expect(bad.statusCode).toBe(415);
    const missing = await app.inject({ method: "GET", url: `/api/assets/${"0".repeat(64)}` });
    expect(missing.statusCode).toBe(404);
  });
});

describe("権限・プライベートな作業", () => {
  const preview = (marker: string) => ({
    anchor: [0, 0, 0],
    isolated: false,
    outputKind: "item",
    bounds: { center: [0, 1, 0], size: [1, 1, 1] },
    world: { marker },
    materials: [{ id: "m" }],
  });

  it("編集中の見た目は、開いていない人へ権限に合わせて届く（閲覧できなければ境界だけ）", async () => {
    const { url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    a.send({ t: "ws.preview", workspaceId, preview: preview("v1") });
    const full = await b.next("ws.preview");
    expect(full).toMatchObject({
      name: "銃",
      restricted: false,
      preview: { world: { marker: "v1" } },
    });
    // ホスト以外（開いていない人）の見た目は受け付けない
    b.send({ t: "ws.preview", workspaceId, preview: preview("x") });
    // 非公開にすると、境界だけになる
    a.send({ t: "ws.setDefaultRole", workspaceId, role: null });
    const restricted = await b.next("ws.preview", (m) => m.restricted);
    expect(restricted).toMatchObject({
      name: "作業中",
      preview: { world: null, materials: [], bounds: { size: [1, 1, 1] } },
    });
    // 後から入った人にも最新の見た目が届く
    const c = await client(url, "c");
    c.send({ t: "session.join", sessionId: (await b.next("session")).session.id });
    expect((await c.next("ws.preview")).restricted).toBe(true);
    expect(a.inbox.some((m) => m.t === "ws.preview")).toBe(false);
    expect(
      [...b.inbox, ...c.inbox].some(
        (m) => m.t === "ws.preview" && JSON.stringify(m).includes('"x"'),
      ),
    ).toBe(false);
  });

  it("非公開の作業はセッションに出せない・適用できない", async () => {
    const { url } = await start();
    const { a, workspaceId } = await sessionWithWorkspace(url);
    a.send({ t: "ws.setDefaultRole", workspaceId, role: null });
    await a.next("session", (m) => m.session.workspaces[0]?.defaultRole === null);
    const snapshot = { outputs: [{ id: "out", name: "銃" }] };
    a.send({ t: "place", workspaceId, outputId: "out", snapshot, position: [0, 0, 0], yaw: 0 });
    expect((await a.next("error")).message).toMatch(/非公開/);
    a.send({ t: "apply", workspaceId, outputId: "out", snapshot });
    expect((await a.next("error")).message).toMatch(/非公開|出ていません/);
  });

  it("素材は、上げた人と、使っている制作データを閲覧できる人だけが取り出せる", async () => {
    const { app, url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const id = assetId(png);
    await app.inject({
      method: "POST",
      url: "/api/assets",
      headers: { "content-type": "image/png", "x-tukurium-token": a.token },
      payload: png,
    });
    const get = (token?: string) =>
      app.inject({ method: "GET", url: `/api/assets/${id}${token ? `?t=${token}` : ""}` });
    expect((await get()).statusCode).toBe(404);
    expect((await get(a.token)).statusCode).toBe(200);
    expect((await get(b.token)).statusCode).toBe(404);
    // ワークスペースで使うと、閲覧できる人は取り出せる
    a.send({ t: "ws.open", workspaceId });
    const ref = new Y.Doc();
    ref.getMap("assets").set(id, { id, kind: "image", contentType: "image/png", name: "p" });
    a.send({
      t: "ws.update",
      workspaceId,
      update: Buffer.from(Y.encodeStateAsUpdate(ref)).toString("base64"),
    });
    await expect.poll(async () => (await get(b.token)).statusCode).toBe(200);
    // 非公開にすると、取り出せなくなる
    a.send({ t: "ws.setDefaultRole", workspaceId, role: null });
    await b.next("session", (m) => m.session.workspaces[0]?.defaultRole === null);
    a.send({ t: "ws.setRole", workspaceId, userId: b.me.id, role: null });
    await expect.poll(async () => (await get(b.token)).statusCode).toBe(404);
  });
});

describe("リポジトリ・コミット・作品", () => {
  it("リポジトリを作り、履歴・ファイル・差分を見られる。非公開は持ち主だけ", async () => {
    const { app, url } = await start();
    const a = await client(url, "a");
    const b = await client(url, "b");
    const A = api(app, a.token);
    const B = api(app, b.token);
    const repo = (await A.post("/api/repos", { name: "銃と的", template: "sample" })).json();
    expect(repo).toMatchObject({
      name: "銃と的",
      visibility: "public",
      owner: a.me.id,
      ownerName: "a",
    });
    const info = (await B.get(`/api/repos/${repo.id}`)).json();
    expect(info.outputs.map((o: { name: string }) => o.name)).toEqual(["射撃場"]);
    expect(info.canFork).toBe(true);
    const commits = (await B.get(`/api/repos/${repo.id}/commits`)).json();
    expect(commits.map((c: { message: string }) => c.message)).toEqual(["最初のコミット"]);
    const files = (await B.get(`/api/repos/${repo.id}/files`)).json();
    expect(files["systems/sys_shoot.ts"]).toContain("system(");
    const diff = (await B.get(`/api/repos/${repo.id}/commits/${commits[0].oid}/diff`)).json();
    expect(diff.every((d: { change: string }) => d.change === "added")).toBe(true);

    expect((await A.patch(`/api/repos/${repo.id}`, { visibility: "private" })).statusCode).toBe(
      200,
    );
    expect((await B.get(`/api/repos/${repo.id}`)).statusCode).toBe(404);
    // 公式ライブラリ（公式の発行者のリポジトリ）は、いつも見える
    const mine = (list: { owner: string }[]) => list.filter((r) => r.owner !== "u_official");
    expect(mine((await B.get("/api/repos")).json())).toEqual([]);
    expect(mine((await A.get("/api/repos")).json())).toHaveLength(1);
    expect((await B.patch(`/api/repos/${repo.id}`, { visibility: "public" })).statusCode).toBe(403);
  });

  it("ワークスペースを作るとリポジトリができ、持ち主がコミットすると一緒に編集した人が Co-author になる", async () => {
    const { app, url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    const repoId = workspaceId.replace(/^w_/, "");
    b.send({ t: "ws.open", workspaceId });
    await b.next("ws.doc");
    // b はコミットできない
    b.send({ t: "ws.commit", workspaceId, message: "x" });
    expect((await b.next("error")).message).toMatch(/持ち主/);
    a.send({ t: "ws.commit", workspaceId, message: "的を増やした" });
    const done = await b.next("ws.committed");
    expect(done).toMatchObject({ message: "的を増やした", by: "れにうむ" });
    const commits = (await api(app, a.token).get(`/api/repos/${repoId}/commits`)).json();
    expect(commits[0].message).toContain("的を増やした");
    expect(commits[0].message).toContain("Co-authored-by: ここあ");
  });

  it("持ち主はプロジェクト名を変えられ、開いているワークスペースの名前と制作データにも反映される", async () => {
    const { app, url } = await start();
    const { a, b, workspaceId } = await sessionWithWorkspace(url);
    const repoId = workspaceId.replace(/^w_/, "");
    expect((await api(app, b.token).patch(`/api/repos/${repoId}`, { name: "x" })).statusCode).toBe(
      403,
    );
    expect((await api(app, a.token).patch(`/api/repos/${repoId}`, { name: "  " })).statusCode).toBe(
      400,
    );
    const res = await api(app, a.token).patch(`/api/repos/${repoId}`, { name: " 新しい射撃場 " });
    expect(res.json()).toMatchObject({ name: "新しい射撃場" });
    const s = await b.next("session", (m) => m.session.workspaces[0]?.name === "新しい射撃場");
    expect(s.session.workspaces[0]?.repoId).toBe(repoId);
    // 制作データの名前も変わる（次のコミットに入る）
    a.send({ t: "ws.commit", workspaceId, message: "名前を変えた" });
    await a.next("ws.committed");
    const files = (await api(app, a.token).get(`/api/repos/${repoId}/files`)).json();
    expect(JSON.stringify(files)).toContain("新しい射撃場");
  });

  it("1 リポジトリ 1 ワークスペース：別のセッションで開かれていたら断る。同じセッションなら参加する", async () => {
    const { app, url } = await start();
    const { a, workspaceId } = await sessionWithWorkspace(url);
    const repoId = workspaceId.replace(/^w_/, "");
    const c = await client(url, "c");
    c.send({ t: "session.create", name: "別の部屋" });
    await c.next("session");
    c.send({ t: "ws.openRepo", repoId });
    expect((await c.next("ws.denied")).reason).toMatch(/別のセッション/);
    // 同じセッションの人が repo から開くと、同じワークスペースに入る
    const sid = (await a.next("session")).session.id;
    const d = await client(url, "d");
    d.send({ t: "session.join", sessionId: sid });
    await d.next("session");
    d.send({ t: "ws.openRepo", repoId });
    expect((await d.next("ws.created")).workspaceId).toBe(workspaceId);
    expect((await d.next("ws.doc")).workspaceId).toBe(workspaceId);
    expect(app).toBeTruthy();
  });

  it("フォーク・抽出（新規・既存）で由来が残る。作品の公開・リリース・権限", async () => {
    const { app, url } = await start();
    const a = await client(url, "a");
    const b = await client(url, "b");
    const A = api(app, a.token);
    const B = api(app, b.token);
    const src = (await A.post("/api/repos", { name: "銃と的", template: "sample" })).json();

    const fork = (await B.post(`/api/repos/${src.id}/fork`, {})).json();
    expect(fork).toMatchObject({
      owner: b.me.id,
      forkedFrom: { repoId: src.id, repoName: "銃と的" },
    });
    const forkInfo = (await B.get(`/api/repos/${fork.id}`)).json();
    expect(forkInfo.provenance[0]).toMatchObject({ kind: "fork", repoId: src.id });
    expect((await B.get(`/api/repos/${fork.id}/commits`)).json()).toHaveLength(2);

    const ex = (
      await B.post(`/api/repos/${src.id}/extract`, {
        selection: { kokostates: ["ks_gun"], systems: ["sys_shoot"] },
        target: { name: "銃の部品" },
      })
    ).json();
    const exSnap = (await B.get(`/api/repos/${ex.repo.id}/snapshot`)).json();
    expect(exSnap.kokostates.map((k: { name: string }) => k.name)).toEqual(["Gun"]);
    expect(exSnap.provenance[0]).toMatchObject({
      kind: "extract",
      repoId: src.id,
      items: ["Gun", "Shoot"],
    });

    const range = (await B.post("/api/repos", { name: "射撃場", template: "range" })).json();
    await B.post(`/api/repos/${src.id}/extract`, {
      selection: { outputs: ["out_range"] },
      target: { repoId: range.id },
    });
    const merged = (await B.get(`/api/repos/${range.id}/snapshot`)).json();
    expect(merged.outputs).toHaveLength(2);
    // 他人のリポジトリには取り込めない
    const bad = await A.post(`/api/repos/${src.id}/extract`, {
      selection: { outputs: ["out_range"] },
      target: { repoId: range.id },
    });
    expect(bad.statusCode).toBe(403);

    // 作品：持ち主だけが公開・リリースできる。既定ですべて許可
    expect((await B.post("/api/works", { repoId: src.id, outputId: "out_range" })).statusCode).toBe(
      403,
    );
    const work = (await A.post("/api/works", { repoId: src.id, outputId: "out_range" })).json();
    expect(work.perms).toEqual({ use: true, view: true, fork: true });
    const r1 = (await A.post(`/api/works/${work.id}/releases`)).json();
    const r2 = (await A.post(`/api/works/${work.id}/releases`)).json();
    expect([r1.version, r2.version]).toEqual([1, 2]);
    const list = (await B.get("/api/works")).json();
    expect(list[0]).toMatchObject({
      name: "射撃場",
      repoName: "銃と的",
      latest: { version: 2 },
      outputKind: "item",
    });

    // 非公開のリポジトリでも、作品の「閲覧」権限があれば見られる。外せば見られない
    await A.patch(`/api/repos/${src.id}`, { visibility: "private" });
    expect((await B.get(`/api/repos/${src.id}`)).statusCode).toBe(200);
    await A.patch(`/api/works/${work.id}`, { perms: { view: false, fork: false } });
    expect((await B.get(`/api/repos/${src.id}`)).statusCode).toBe(404);
    expect((await B.post(`/api/repos/${src.id}/fork`, {})).statusCode).toBe(403);

    const profile = (await B.get(`/api/users/${a.me.id}`)).json();
    expect(profile.name).toBe("a");
    expect(profile.works).toHaveLength(1);
  });

  it("入力のプレイヤー ID は、自己申告ではなく接続の本人にしてホストへ渡す（ADR 0018）", async () => {
    const { url } = await start();
    const a = await client(url, "a");
    a.send({ t: "session.create", name: "部屋" });
    const host = await a.next("session.host");
    const info = await a.next("session");
    expect(host).toBeTruthy();
    const b = await client(url, "b");
    b.send({ t: "session.join", sessionId: info.session.id });
    await b.next("session");
    b.send({
      t: "session.input",
      input: {
        action: "use",
        phase: "down",
        origin: [0, 0, 0],
        direction: [0, 0, -1],
        player: a.me.id,
      },
    });
    const got = await a.next("host.input");
    expect(got.input.player).toBe(b.me.id);
  });

  it("公式ライブラリは起動のときに用意され、公式の印は発行者で決まる", async () => {
    const { app, url } = await start();
    const a = await client(url, "Tukurium 公式");
    const A = api(app, a.token);
    const works = (await A.get("/api/works")).json() as {
      id: string;
      official: boolean;
      outputKind: string;
      thumbnail: string | null;
    }[];
    expect(works.find((w) => w.id === "w_official_combat")).toMatchObject({
      official: true,
      outputKind: "library",
    });
    // 公式ライブラリには同梱のサムネイルが付いていて、誰でも取り出せる（ADR 0046）
    for (const id of ["w_official_combat", "w_official_interaction", "w_official_items"]) {
      const thumb = works.find((w) => w.id === id)?.thumbnail;
      expect(thumb).toMatch(/^[0-9a-f]{64}$/);
      const got = await app.inject({ method: "GET", url: `/api/assets/${thumb}?t=${a.token}` });
      expect(got.statusCode).toBe(200);
      expect(got.headers["content-type"]).toBe("image/png");
    }
    // 同じ名前の利用者が出しても、公式にはならない
    const repo = (await A.post("/api/repos", { name: "combat", template: "gun" })).json();
    const work = (await A.post("/api/works", { repoId: repo.id, outputId: "out_gun" })).json();
    const list = (await A.get("/api/works")).json() as { id: string; official: boolean }[];
    expect(list.find((w) => w.id === work.id)?.official).toBe(false);
  });

  it("作品のリリースをセッションに置く（利用の権限）", async () => {
    const { app, url } = await start();
    const a = await client(url, "a");
    const A = api(app, a.token);
    const src = (await A.post("/api/repos", { name: "射撃場", template: "range" })).json();
    const work = (await A.post("/api/works", { repoId: src.id, outputId: "out_range" })).json();
    const rel = (await A.post(`/api/works/${work.id}/releases`)).json();
    a.send({ t: "session.create", name: "部屋" });
    await a.next("session.host");
    a.send({ t: "placeRelease", releaseId: rel.id, position: [0, 0, 0], yaw: 0 });
    const add = await a.next("host.addPart");
    expect(add.part.realm).toBe(`rel_${rel.id}`);
    expect((add.part.snapshot as { name: string }).name).toBe("射撃場");
    const info = await a.next("session", (m) => m.session.placements.length === 1);
    expect(info.session.placements[0]).toMatchObject({
      workspaceId: null,
      releaseId: rel.id,
      workspaceName: "射撃場 v1",
    });

    const b = await client(url, "b");
    await A.patch(`/api/works/${work.id}`, { perms: { use: false } });
    b.send({ t: "session.join", sessionId: info.session.id });
    await b.next("session");
    b.send({ t: "placeRelease", releaseId: rel.id, position: [0, 0, 0], yaw: 0 });
    expect((await b.next("error")).message).toMatch(/利用する権限/);
  });

  it("公開されたワールドを開くと、いまのワールドが入れ替わる", async () => {
    const { app, url } = await start({ worldChangeMs: 40 });
    const a = await client(url, "a");
    const A = api(app, a.token);
    const publish = async (name: string, kind: "item" | "world", template: "empty" | "gun") => {
      const repo = (await A.post("/api/repos", { name, kind, template })).json() as { id: string };
      const detail = (await A.get(`/api/repos/${repo.id}`)).json() as {
        outputs: { id: string }[];
      };
      const outputId = detail.outputs[0]?.id;
      if (!outputId) throw new Error("output がありません");
      const work = (await A.post("/api/works", { repoId: repo.id, outputId })).json() as {
        id: string;
      };
      const rel = (await A.post(`/api/works/${work.id}/releases`)).json() as { id: string };
      return { workId: work.id, releaseId: rel.id };
    };
    const item = await publish("銃", "item", "gun");
    const plaza = await publish("広場", "world", "empty");
    const night = await publish("夜", "world", "empty");

    a.send({ t: "session.create", name: "部屋" });
    await a.next("session.host");
    a.send({ t: "placeRelease", releaseId: item.releaseId, position: [1, 0, 1], yaw: 0 });
    await a.next("session", (m) => m.session.placements.length === 1);

    a.send({ t: "session.openWorld", releaseId: plaza.releaseId });
    const opened = await a.next("session", (m) =>
      m.session.placements.some((p) => p.outputKind === "world"),
    );
    expect(opened.session.placements).toHaveLength(2);
    expect(opened.session.placements.find((p) => p.outputKind === "world")).toMatchObject({
      releaseId: plaza.releaseId,
      position: [0, 0, 0],
      outputName: "広場",
    });
    expect(opened.session.placements.some((p) => p.releaseId === item.releaseId)).toBe(true);

    a.send({ t: "session.openWorld", releaseId: night.releaseId });
    const swapped = await a.next("session", (m) =>
      m.session.placements.some((p) => p.releaseId === night.releaseId),
    );
    expect(swapped.session.placements.filter((p) => p.outputKind === "world")).toEqual([
      expect.objectContaining({ releaseId: night.releaseId, outputName: "夜" }),
    ]);
    expect(swapped.session.placements.some((p) => p.releaseId === item.releaseId)).toBe(true);

    a.send({ t: "session.openWorld", releaseId: item.releaseId });
    expect((await a.next("error")).message).toMatch(/ワールドではありません/);

    const b = await client(url, "b");
    await A.patch(`/api/works/${night.workId}`, { perms: { use: false } });
    b.send({ t: "session.join", sessionId: opened.session.id });
    await b.next("session");
    b.send({ t: "session.openWorld", releaseId: night.releaseId });
    expect((await b.next("error")).message).toMatch(/利用する権限/);
  });

  it("入れ替えの前に全員へカウントダウンを出し、別のワールドを選ぶと数え直す", async () => {
    const { app, url } = await start({ worldChangeMs: 400 });
    const a = await client(url, "a");
    const A = api(app, a.token);
    const publish = async (name: string, kind: "item" | "world") => {
      const repo = (await A.post("/api/repos", { name, kind, template: "empty" })).json() as {
        id: string;
      };
      const detail = (await A.get(`/api/repos/${repo.id}`)).json() as {
        outputs: { id: string }[];
      };
      const outputId = detail.outputs[0]?.id;
      if (!outputId) throw new Error("output がありません");
      const work = (await A.post("/api/works", { repoId: repo.id, outputId })).json() as {
        id: string;
      };
      const rel = (await A.post(`/api/works/${work.id}/releases`)).json() as { id: string };
      return { releaseId: rel.id };
    };
    const plaza = await publish("広場", "world");
    const night = await publish("夜", "world");
    a.send({ t: "session.create", name: "部屋" });
    const room = (await a.next("session")).session;
    const b = await client(url, "b");
    b.send({ t: "session.join", sessionId: room.id });
    await b.next("session");

    a.send({ t: "session.openWorld", releaseId: plaza.releaseId });
    const first = await a.next(
      "session",
      (m) => m.session.worldChange?.releaseId === plaza.releaseId,
    );
    const firstId = first.session.worldChange?.id;
    expect(first.session.worldChange).toMatchObject({ worldName: "広場", byName: "a" });
    expect(first.session.worldChange?.remainingMs).toBeGreaterThan(0);
    expect(first.session.placements.some((p) => p.outputKind === "world")).toBe(false);
    const seen = await b.next(
      "session",
      (m) => m.session.worldChange?.releaseId === plaza.releaseId,
    );
    expect(seen.session.worldChange?.byName).toBe("a");

    a.send({ t: "session.openWorld", releaseId: plaza.releaseId });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      a.inbox.some(
        (m) => m.t === "session" && m.session.worldChange && m.session.worldChange.id !== firstId,
      ),
    ).toBe(false);

    a.send({ t: "session.openWorld", releaseId: night.releaseId });
    const replaced = await a.next(
      "session",
      (m) => m.session.worldChange?.releaseId === night.releaseId,
    );
    expect(replaced.session.worldChange?.id).not.toBe(firstId);
    expect(replaced.session.placements.some((p) => p.releaseId === night.releaseId)).toBe(false);
    const swapped = await a.next("session", (m) =>
      m.session.placements.some((p) => p.releaseId === night.releaseId),
    );
    expect(swapped.session.worldChange).toBeNull();
    expect(swapped.session.placements.filter((p) => p.outputKind === "world")).toEqual([
      expect.objectContaining({ releaseId: night.releaseId, outputName: "夜" }),
    ]);
    const bSwapped = await b.next("session", (m) =>
      m.session.placements.some((p) => p.releaseId === night.releaseId),
    );
    expect(bSwapped.session.worldChange).toBeNull();
  });

  it("選んだワールドでセッションを開くと、そのワールドが最初から開いている", async () => {
    const { app, url } = await start();
    const a = await client(url, "a");
    const A = api(app, a.token);
    const repo = (
      await A.post("/api/repos", { name: "森", kind: "world", template: "empty" })
    ).json() as { id: string };
    const detail = (await A.get(`/api/repos/${repo.id}`)).json() as { outputs: { id: string }[] };
    const outputId = detail.outputs[0]?.id;
    if (!outputId) throw new Error("output がありません");
    const work = (await A.post("/api/works", { repoId: repo.id, outputId })).json() as {
      id: string;
    };
    const rel = (await A.post(`/api/works/${work.id}/releases`)).json() as { id: string };
    a.send({ t: "session.create", name: "森の部屋", worldReleaseId: rel.id });
    const entered = await a.next("session");
    expect(entered.session.name).toBe("森の部屋");
    expect(entered.session.worldChange).toBeNull();
    expect(entered.session.placements.find((p) => p.outputKind === "world")).toMatchObject({
      releaseId: rel.id,
      position: [0, 0, 0],
      outputName: "森",
    });

    a.send({
      t: "session.create",
      name: "だめ",
      worldReleaseId: "rel_missing",
      requestId: "req-w",
    });
    const missing = await a.next("session.rejected");
    expect(missing.requestId).toBe("req-w");
    expect(missing.message).toMatch(/バージョンが見つかりません/);

    const itemRepo = (
      await A.post("/api/repos", { name: "銃", kind: "item", template: "gun" })
    ).json() as { id: string };
    const itemDetail = (await A.get(`/api/repos/${itemRepo.id}`)).json() as {
      outputs: { id: string }[];
    };
    const itemOutput = itemDetail.outputs[0]?.id;
    if (!itemOutput) throw new Error("output がありません");
    const itemWork = (
      await A.post("/api/works", { repoId: itemRepo.id, outputId: itemOutput })
    ).json() as { id: string };
    const itemRel = (await A.post(`/api/works/${itemWork.id}/releases`)).json() as { id: string };
    a.send({
      t: "session.create",
      name: "アイテムの部屋",
      worldReleaseId: itemRel.id,
      requestId: "req-item",
    });
    const rejected = await a.next("session.rejected");
    expect(rejected.requestId).toBe("req-item");
    expect(rejected.message).toMatch(/ワールドではありません/);
    for (let i = a.inbox.length - 1; i >= 0; i--)
      if (a.inbox[i]?.t === "sessions") a.inbox.splice(i, 1);
    a.send({ t: "sessions.list" });
    const list = await a.next("sessions");
    expect(list.sessions.map((s) => s.name)).toEqual(["森の部屋"]);
  });
});

describe("公開タグ", () => {
  it("作者のタグを検索と所持品へ共有し、作者以外の変更と不正なタグを拒否する", async () => {
    const { app, store } = await start();
    const author = await store.createUser("作者");
    const reader = await store.createUser("利用者");
    const A = api(app, author.token),
      B = api(app, reader.token);
    const repo = (
      await A.post("/api/repos", { name: "タグ付きの銃", kind: "item", template: "gun" })
    ).json();
    const detail = (await A.get(`/api/repos/${repo.id}`)).json();
    const published = await A.post("/api/works", {
      repoId: repo.id,
      outputId: detail.outputs[0].id,
      tags: ["ゲーム", " 複数人 ", "ゲーム"],
    });
    expect(published.statusCode).toBe(200);
    const work = published.json();
    expect(work.tags).toEqual(["ゲーム", "複数人"]);
    const release = (await A.post(`/api/works/${work.id}/releases`)).json();
    await B.post(`/api/me/items/${work.id}`, { releaseId: release.id });
    const search = (await B.get("/api/market?q=複数人&tag=ゲーム&tag=複数人&limit=1")).json();
    expect(search.total).toBe(1);
    expect(search.items[0].tags).toEqual(["ゲーム", "複数人"]);
    expect((await B.get("/api/market?tag=ゲーム大好き")).json().items).toEqual([]);
    expect((await B.patch(`/api/works/${work.id}`, { tags: ["書き換え"] })).statusCode).toBe(403);
    expect((await A.patch(`/api/works/${work.id}`, { tags: ["a".repeat(25)] })).statusCode).toBe(
      400,
    );
    expect(
      (
        await A.patch(`/api/works/${work.id}`, {
          tags: Array.from({ length: 13 }, (_, i) => `tag${i}`),
        })
      ).statusCode,
    ).toBe(400);
    expect((await A.patch(`/api/works/${work.id}`, { tags: [" "] })).statusCode).toBe(400);
    expect((await A.patch(`/api/works/${work.id}`, { tags: ["道具"] })).statusCode).toBe(200);
    expect((await B.get("/api/market?tag=複数人")).json().total).toBe(0);
    const found = (await app.inject({ method: "GET", url: "/api/market?q=道具" })).json();
    expect(found.items.map((item: { id: string }) => item.id)).toContain(work.id);
    const owned = (await B.get("/api/me/items")).json()[0];
    expect(owned.work.tags).toEqual(["道具"]);
    expect(owned.releaseId).toBe(release.id);
    expect(owned.release.version).toBe(1);
    await A.patch(`/api/works/${work.id}`, { tags: [] });
    expect((await B.get("/api/me/items")).json()[0].work.tags).toEqual([]);
    const saved = await store.work(work.id);
    if (!saved) throw new Error("作品がありません");
    const { tags: _tags, ...legacy } = saved;
    await store.saveWork(legacy);
    expect((await B.get("/api/market")).json().items[0].tags).toEqual([]);
  });
});
