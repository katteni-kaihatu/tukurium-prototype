import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { stringifyValue } from "@tukurium/eks";
import { PROTOCOL_VERSION } from "@tukurium/shared";
import Fastify from "fastify";
import { registerMcp } from "./agent/mcp";
import {
  ASSET_TYPES,
  type AssetStore,
  DiskAssetStore,
  MAX_ASSET_BYTES,
  S3AssetStore,
} from "./assets/assetStore";
import type { Config } from "./config";
import { Hub, type HubOptions } from "./hub";
import { registerRepoRoutes } from "./repos/routes";
import { RepoService } from "./repos/service";
import { seedSampleModels } from "./sampleModels";
import { registerSocialRoutes } from "./social/routes";
import { PostgresStore } from "./store/postgres";
import { MemoryStore, type Store, type User } from "./store/store";

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
  const repos = new RepoService(store, config.gitDir);
  // 同梱の公式ライブラリを用意する（中身が変わっていれば新しい版を出す。ADR 0016）
  await repos.ensureOfficialLibraries();
  const hub = new Hub(store, { log: (m) => app.log.info(m), repos, ...options.hub });

  // 返事は、タグ付きの JSON で書く（制作データの値を欠かさず返すため。ADR 0065）。
  // クライアントは parseValue で読む。JSON で表せる値は、今までと同じ形になる
  app.setReplySerializer((payload) => stringifyValue(payload));

  // Yjs の更新を運ぶので大きめにする（初期内容の送信など）
  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024 } });

  registerRepoRoutes(app, store, repos, {
    onRenamed: (repoId, name) => hub.renameRepo(repoId, name),
  });
  registerSocialRoutes(app, store, hub);
  // 素材（GLB・画像・音声）。本文をそのまま受け取り、中身の SHA-256 を ID にして保存する
  const assets =
    options.assets ??
    (config.s3 ? new S3AssetStore(config.s3) : new DiskAssetStore(config.assetDir));
  await seedSampleModels(assets);
  // AI エージェントのためのリモート MCP（ADR 0054・0059）
  registerMcp(app, hub, repos, assets);
  // テストから hub に内部でつなぐための入口
  app.decorate("tukuriumHub", hub);

  app.get("/api/health", async () => ({ ok: true, protocol: PROTOCOL_VERSION, ...hub.stats }));
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
    const set = uploaders.get(id) ?? new Set<string>();
    set.add(user.id);
    uploaders.set(id, set);
    return { id, kind, contentType, size: req.body.length };
  });
  // 素材を上げた人（再起動で消える。消えてもワークスペース・リポジトリの閲覧権限で見られる）
  const uploaders = new Map<string, Set<string>>();
  // リポジトリを読む判定は重いので、見られると分かった組を少しの間覚えておく
  const seen = new Map<string, number>();
  const SEEN_MS = 60_000;
  const canSee = async (user: User, id: string): Promise<boolean> => {
    if (uploaders.get(id)?.has(user.id) || hub.canSeeAssetLive(user, id)) return true;
    const key = `${user.id}:${id}`;
    const until = seen.get(key);
    if (until && until > Date.now()) return true;
    if (!(await hub.canSeeAssetInRepos(user, id))) return false;
    if (seen.size > 10_000) seen.clear();
    seen.set(key, Date.now() + SEEN_MS);
    return true;
  };
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>(
    "/api/assets/:id",
    async (req, reply) => {
      // 素材の取得にも権限をかける（要件 §8）：本人確認（クエリの t か、ヘッダー）と閲覧権限
      const token = req.query.t ?? req.headers["x-tukurium-token"];
      const user = typeof token === "string" ? await store.userByToken(token) : null;
      const allowed = user !== null && (await canSee(user, req.params.id));
      if (!allowed) return reply.code(404).send({ error: "not found" });
      const asset = await assets.get(req.params.id);
      if (!asset) return reply.code(404).send({ error: "not found" });
      return (
        reply
          .header("content-type", asset.contentType)
          // 権限で見せ分けるので、共有キャッシュには置かない
          .header("cache-control", "private, max-age=3600")
          .send(asset.data)
      );
    },
  );

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
