import { PROTOCOL_VERSION, type ServerMessage } from "@tukurium/shared";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "./app";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start() {
  const app = await buildApp({ host: "127.0.0.1", port: 0, clientDir: undefined });
  await app.listen({ host: "127.0.0.1", port: 0 });
  close = () => app.close();
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { app, url: `ws://127.0.0.1:${addr.port}/ws` };
}

function client(url: string) {
  const ws = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (d) => {
    inbox.push(JSON.parse(d.toString()));
    for (const w of waiters.splice(0)) w();
  });
  const next = async (t: ServerMessage["t"]): Promise<ServerMessage> => {
    for (;;) {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return inbox.splice(i, 1)[0] as ServerMessage;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const opened = new Promise<void>((r) => ws.once("open", () => r()));
  return { ws, inbox, next, opened, send: (m: object) => ws.send(JSON.stringify(m)) };
}

describe("server", () => {
  it("health", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
  });

  it("参加者の位置を他の参加者へ中継する", async () => {
    const { url } = await start();
    const a = client(url);
    const b = client(url);
    await Promise.all([a.opened, b.opened]);
    a.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "れにうむ" });
    await a.next("welcome");
    b.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "ここあ" });
    const wb = await b.next("welcome");
    expect(wb.t === "welcome" && wb.participants.map((p) => p.name)).toEqual(["れにうむ"]);
    expect((await a.next("joined")).t).toBe("joined");

    a.send({ t: "pose", position: [1, 2, 3], yaw: 0.5, pitch: 0 });
    const pose = await b.next("pose");
    expect(pose).toMatchObject({ position: [1, 2, 3], yaw: 0.5 });

    a.ws.close();
    expect((await b.next("left")).t).toBe("left");
    b.ws.close();
  });

  it("2回目の hello では参加の通知を繰り返さない", async () => {
    const { url } = await start();
    const a = client(url);
    const b = client(url);
    await Promise.all([a.opened, b.opened]);
    a.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "a" });
    await a.next("welcome");
    b.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "b" });
    await b.next("welcome");
    await a.next("joined");
    b.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "b2" });
    b.send({ t: "pose", position: [0, 0, 1], yaw: 0, pitch: 0 });
    await a.next("pose");
    // 2回目の hello による joined は pose より先に届くはずなので、届いていなければ無視されている
    expect(a.inbox.some((m) => m.t === "joined")).toBe(false);
    a.ws.close();
    b.ws.close();
  });

  it("不正なメッセージにはエラーを返す", async () => {
    const { url } = await start();
    const a = client(url);
    await a.opened;
    a.send({ t: "nope" });
    expect((await a.next("error")).t).toBe("error");
    a.ws.close();
  });
});
