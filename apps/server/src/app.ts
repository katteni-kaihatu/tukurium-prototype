import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { PROTOCOL_VERSION } from "@tukurium/shared";
import Fastify from "fastify";
import type { Config } from "./config";
import { Hub, type HubOptions } from "./hub";
import { PostgresStore } from "./store/postgres";
import { MemoryStore, type Store } from "./store/store";

export async function buildApp(config: Config, options: { store?: Store; hub?: HubOptions } = {}) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const store =
    options.store ??
    (config.databaseUrl ? new PostgresStore(config.databaseUrl) : new MemoryStore());
  await store.init();
  if (!config.databaseUrl && !options.store) {
    app.log.warn("DATABASE_URL が未設定のため、メモリに保存します（再起動で消えます）");
  }
  const hub = new Hub(store, { log: (m) => app.log.info(m), ...options.hub });

  // Yjs の更新を運ぶので大きめにする（初期内容の送信など）
  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024 } });

  app.get("/api/health", async () => ({ ok: true, protocol: PROTOCOL_VERSION, ...hub.stats }));

  app.get("/ws", { websocket: true }, (socket) => {
    const conn = hub.connect({
      send: (data) => socket.send(data),
      close: () => socket.close(),
    });
    socket.on("message", (data) => conn.onMessage(data.toString()));
    socket.on("close", () => conn.onClose());
  });

  if (config.clientDir) {
    await app.register(fastifyStatic, { root: config.clientDir, wildcard: false });
    // SPA：API 以外の未知のパスは index.html を返す
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/ws")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    await hub.flush();
    await store.close();
  });

  return app;
}
