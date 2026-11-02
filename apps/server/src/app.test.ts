import { PROTOCOL_VERSION, type ServerMessage } from "@tukurium/shared";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { buildApp } from "./app";
import { MemoryStore } from "./store/store";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(opts: { ownerGraceMs?: number } = {}) {
  const store = new MemoryStore();
  const app = await buildApp(
    { host: "127.0.0.1", port: 0, clientDir: undefined, databaseUrl: undefined },
    { store, hub: { ownerGraceMs: opts.ownerGraceMs ?? 60_000, saveDelayMs: 20 } },
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  close = () => app.close();
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { app, store, url: `ws://127.0.0.1:${addr.port}/ws` };
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

describe("本人識別とセッション", () => {
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
});

describe("ワークスペースのホストと共有再生", () => {
  const frame = (mode: "play" | "edit", time = 1) => ({
    mode,
    outputId: "out",
    time,
    world: { entities: [] },
    names: {},
    status: [],
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
    a.send({ t: "ws.frame", workspaceId, frame: frame("play", 3.5) });
    await b.next("ws.frame");
    a.ws.close();
    const host = await b.next("ws.host");
    expect(host.resume?.time).toBe(3.5);
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

    const frame = { time: 1, world: { entities: [] }, names: {}, materials: [], status: [] };
    a.send({ t: "session.frame", frame });
    expect((await b.next("session.frame")).frame.time).toBe(1);
    // ホスト以外の世界の状態は受け付けない
    b.send({ t: "session.frame", frame: { ...frame, time: 9 } });
    await new Promise((r) => setTimeout(r, 80));
    expect(a.inbox.some((m) => m.t === "session.frame")).toBe(false);
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
    const frame = { time: 4.2, world: { entities: [] }, names: {}, materials: [], status: [] };
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

    a2.send({ t: "resetPart", placementId: pid });
    expect((await a2.next("host.resetPart")).id).toBe(pid);
    a2.send({ t: "unplace", placementId: pid });
    expect((await a2.next("host.removePart")).id).toBe(pid);
  });
});
