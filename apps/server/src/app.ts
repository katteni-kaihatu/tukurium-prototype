import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { PROTOCOL_VERSION } from "@tukurium/shared";
import Fastify from "fastify";
import type { Config } from "./config";
import { Lobby } from "./lobby";

export async function buildApp(config: Config) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const lobby = new Lobby();

  await app.register(fastifyWebsocket);

  app.get("/api/health", async () => ({
    ok: true,
    protocol: PROTOCOL_VERSION,
    participants: lobby.size,
  }));

  app.get("/ws", { websocket: true }, (socket) => {
    const conn = lobby.connect({
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

  return app;
}
