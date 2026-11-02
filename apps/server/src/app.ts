import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { PROTOCOL_VERSION } from "@tukurium/shared";
import Fastify from "fastify";
import {
  ASSET_TYPES,
  type AssetStore,
  DiskAssetStore,
  MAX_ASSET_BYTES,
  S3AssetStore,
} from "./assets/assetStore";
import type { Config } from "./config";
import { Hub, type HubOptions } from "./hub";
import { PostgresStore } from "./store/postgres";
import { MemoryStore, type Store } from "./store/store";

export async function buildApp(
  config: Config,
  options: { store?: Store; hub?: HubOptions; assets?: AssetStore } = {},
) {
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

  // 素材（GLB・画像・音声）。本文をそのまま受け取り、中身の SHA-256 を ID にして保存する
  const assets =
    options.assets ??
    (config.s3 ? new S3AssetStore(config.s3) : new DiskAssetStore(config.assetDir));
  app.addContentTypeParser(
    Object.keys(ASSET_TYPES),
    { parseAs: "buffer", bodyLimit: MAX_ASSET_BYTES },
    (_req, body, done) => done(null, body),
  );
  app.post("/api/assets", async (req, reply) => {
    const token = req.headers["x-tukurium-token"];
    const user = typeof token === "string" ? await store.userByToken(token) : null;
    if (!user)
      return reply.code(401).send({ error: "本人確認ができません（接続し直してください）" });
    const contentType =
      String(req.headers["content-type"] ?? "")
        .split(";")[0]
        ?.trim() ?? "";
    const kind = ASSET_TYPES[contentType];
    if (!kind || !Buffer.isBuffer(req.body)) {
      return reply
        .code(415)
        .send({ error: "GLB・PNG・JPEG・WebP・MP3・OGG・WAV のみ受け付けます" });
    }
    const id = await assets.put(req.body, contentType);
    return { id, kind, contentType, size: req.body.length };
  });
  app.get<{ Params: { id: string } }>("/api/assets/:id", async (req, reply) => {
    const asset = await assets.get(req.params.id);
    if (!asset) return reply.code(404).send({ error: "not found" });
    // 中身から決まる ID なので、ずっとキャッシュしてよい
    return reply
      .header("content-type", asset.contentType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(asset.data);
  });

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
