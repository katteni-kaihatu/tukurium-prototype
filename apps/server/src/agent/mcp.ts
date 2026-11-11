import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AssetStore } from "../assets/assetStore";
import type { Hub } from "../hub";
import type { RepoService } from "../repos/service";
import { AgentClient } from "./AgentClient";
import * as T from "./tools";

/**
 * リモートの MCP（ADR 0054）。`/mcp` で Streamable HTTP を受け、MCP のセッションごとに
 * サーバーの中のエージェント（AgentClient）を一人つくる。トークンはまだない（アカウントができたら足す）。
 */

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

/** 道具の中で起きたエラーは、MCP のエラーの結果として返す（エージェントが読んで直せるように） */
async function run(fn: () => unknown | Promise<unknown>) {
  try {
    return text(await fn());
  } catch (e) {
    return { ...text(e instanceof Error ? e.message : String(e)), isError: true };
  }
}

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const states = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .describe(
    '{ KokoState の名前か ID: { フィールドの名前か ID: 値 } }。例: { "Transform": { "position": [0, 1, -3] } }',
  );
const fieldSpec = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(T.FIELD_TYPES),
  default: z.unknown().optional(),
});

export function createAgentMcp(hub: Hub, repos: RepoService | null, assets: AssetStore) {
  const agent = new AgentClient(hub);
  const server = new McpServer(
    { name: "tukurium", version: "0.1.0" },
    {
      instructions:
        "Tukurium（ブラウザの 3D 空間で複数人がアイテムやワールドを作る）で制作するための道具。" +
        "最初に guide を読み、list_sessions → join_session → open_workspace の順に入ってから作る。" +
        "変更は人の画面にすぐ届く。保存（コミット）は人が行う。",
    },
  );
  const reg = server.registerTool.bind(server);

  reg(
    "guide",
    {
      title: "手引き",
      description: "Tukurium の考え方、進め方、System の書き方の見本、Host API の型",
    },
    () => run(() => T.guide()),
  );

  reg(
    "list_sessions",
    {
      title: "セッションの一覧",
      description: "いま開いているセッション（人が集まって制作している場所）の一覧",
    },
    () =>
      run(async () => {
        if (!agent.me) await agent.hello("エージェント");
        return agent.sessions.map((s) => ({
          id: s.id,
          name: s.name,
          owner: s.owner.name,
          people: s.participants.map((p) => p.name),
        }));
      }),
  );

  reg(
    "join_session",
    {
      title: "セッションに入る",
      description:
        "セッションに参加者として入る。名前には、頼んだ人の名前などを入れる（「エージェント（名前）」と表示される）",
      inputSchema: {
        sessionId: z.string().describe("セッションの ID（s_ で始まる。URL の /s/ のあと）"),
        name: z.string().max(30).optional().describe("表示する名前"),
      },
    },
    ({ sessionId, name }) =>
      run(async () => {
        if (!agent.me) await agent.hello(name ?? "エージェント");
        const s = await agent.joinSession(sessionId);
        return {
          you: agent.me,
          session: s.name,
          workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, present: w.present })),
        };
      }),
  );

  reg(
    "list_workspaces",
    { title: "ワークスペースの一覧", description: "入っているセッションのワークスペース" },
    () =>
      run(() => {
        const s = agent.session;
        if (!s) throw new T.AgentError("セッションに入っていません。join_session で入ってください");
        return s.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          defaultRole: w.defaultRole,
          present: w.present,
        }));
      }),
  );

  reg(
    "open_workspace",
    {
      title: "ワークスペースを開く",
      description: "ワークスペースを開いて制作を始める。開くと、プロジェクトの要約を返す",
      inputSchema: { workspaceId: z.string() },
    },
    ({ workspaceId }) =>
      run(async () => {
        const w = await agent.openWorkspace(workspaceId);
        return { role: w.role, project: T.overview(w.project) };
      }),
  );

  reg(
    "get_project",
    {
      title: "プロジェクトの要約",
      description: "アウトプット・Entity の木・KokoState・System・Material・素材の一覧",
    },
    () => run(() => T.overview(T.projectOf(agent).project)),
  );

  reg(
    "get_entity",
    {
      title: "Entity を読む",
      description: "Entity の KokoState とフィールドの値",
      inputSchema: { entity: z.string().describe("Entity の ID か名前") },
    },
    ({ entity }) => run(() => T.entityDetail(T.projectOf(agent).project, entity)),
  );

  reg(
    "get_entities",
    {
      title: "Entity をまとめて読む",
      description:
        "条件をすべて満たす Entity のフィールドと、親をたどった世界座標を返す。total と truncated は毎回付き、200 件を超えると続きは含まれない",
      inputSchema: {
        entities: z.array(z.string()).max(200).optional().describe("ID か名前"),
        name: z.string().min(1).max(64).optional().describe("名前の部分一致"),
        kokostate: z.string().optional().describe("付いている KokoState の ID か名前"),
        material: z.string().optional().describe("Mesh が使っている Material の ID か名前"),
        parent: z.string().nullable().optional().describe("親の ID か名前。null はいちばん上"),
      },
    },
    (args) => run(() => T.getEntities(T.projectOf(agent).project, args)),
  );

  reg(
    "get_system",
    {
      title: "System を読む",
      description: "System のコード",
      inputSchema: { system: z.string().describe("System の ID か名前") },
    },
    ({ system }) => run(() => T.systemDetail(T.projectOf(agent).project, system)),
  );

  reg(
    "create_entity",
    {
      title: "Entity を作る",
      description:
        "Entity を作り、KokoState を付ける。形を見せるなら Transform と Mesh。壁・床・坂などプレイヤーや落ちる物がぶつかるものには Collider、重力で落とすなら RigidBody も付ける",
      inputSchema: {
        name: z.string().min(1).max(64),
        output: z.string().optional().describe("アウトプットの ID か名前（省くと最初のもの）"),
        parent: z.string().optional().describe("親の Entity の ID か名前"),
        states: states.optional(),
      },
    },
    (args) => run(() => T.createEntity(T.writable(agent), args)),
  );

  reg(
    "update_entity",
    {
      title: "Entity を変える",
      description:
        "名前・親・KokoState のフィールドを変える。付いていない KokoState は付ける。removeStates で外す",
      inputSchema: {
        entity: z.string(),
        name: z.string().min(1).max(64).optional(),
        parent: z.string().nullable().optional().describe("null でいちばん上へ"),
        states: states.optional(),
        removeStates: z.array(z.string()).optional(),
      },
    },
    (args) => run(() => T.updateEntity(T.writable(agent), args)),
  );

  reg(
    "delete_entity",
    { title: "Entity を消す", description: "Entity を消す", inputSchema: { entity: z.string() } },
    ({ entity }) => run(() => T.deleteEntity(T.writable(agent), entity)),
  );

  const copyPose = z.object({
    ref: z.string().min(1).max(64).optional().describe("この呼び出しの中だけの別名"),
    name: z.string().min(1).max(64).optional().describe("省くと「元の名前 のコピー」"),
    position: vec3.optional(),
    rotation: vec3.optional(),
    scale: vec3.optional(),
  });
  reg(
    "apply_entities",
    {
      title: "Entity をまとめて変える",
      description:
        "作成・更新・削除・複製を、並べた順に行う。成功したものは一つの変更にまとまり、失敗は操作ごとに分かれる。複製は子孫も含め、根の位置だけを置き換えられる",
      inputSchema: {
        ops: z
          .array(
            z.discriminatedUnion("op", [
              z.object({
                op: z.literal("create"),
                ref: z.string().min(1).max(64).optional(),
                name: z.string().min(1).max(64),
                output: z.string().optional(),
                parent: z.string().nullable().optional(),
                states: states.optional(),
              }),
              z.object({
                op: z.literal("update"),
                entity: z.string(),
                name: z.string().min(1).max(64).optional(),
                parent: z.string().nullable().optional(),
                states: states.optional(),
                removeStates: z.array(z.string()).optional(),
              }),
              z.object({ op: z.literal("delete"), entity: z.string() }),
              z.object({
                op: z.literal("duplicate"),
                entity: z.string(),
                copies: z.array(copyPose).min(1).max(200),
              }),
            ]),
          )
          .min(1)
          .max(200),
      },
    },
    ({ ops }) => run(() => T.applyEntities(T.writable(agent), ops)),
  );

  reg(
    "create_kokostate",
    {
      title: "KokoState を作る",
      description:
        "自作の KokoState（続く状態）を作る。フィールドがない KokoState はタグとして使える",
      inputSchema: {
        name: z.string().min(1).max(64),
        fields: z.array(fieldSpec),
        role: z.string().optional().describe("役割（guide を参照）"),
      },
    },
    (args) => run(() => T.createKokoState(T.writable(agent), args)),
  );

  reg(
    "update_kokostate",
    {
      title: "KokoState を変える",
      description:
        "名前・フィールド・役割を変える。fields はフィールドの全部（同じ名前のフィールドは値を引き継ぐ）",
      inputSchema: {
        kokostate: z.string(),
        name: z.string().min(1).max(64).optional(),
        fields: z.array(fieldSpec).optional(),
        role: z.string().optional(),
      },
    },
    (args) => run(() => T.updateKokoState(T.writable(agent), args)),
  );

  reg(
    "create_system",
    {
      title: "System を作る",
      description:
        "System（TypeScript）を作る。既定でアウトプットに入れて有効にする。書き方は guide を参照",
      inputSchema: {
        name: z.string().min(1).max(64),
        code: z.string().max(200_000),
        output: z.string().optional(),
        enable: z.boolean().optional().describe("false ならアウトプットに入れない"),
      },
    },
    (args) => run(() => T.createSystem(T.writable(agent), args)),
  );

  reg(
    "update_system",
    {
      title: "System を変える",
      description: "System のコード（全体）か名前を変える",
      inputSchema: {
        system: z.string(),
        code: z.string().max(200_000).optional(),
        name: z.string().min(1).max(64).optional(),
      },
    },
    (args) => run(() => T.updateSystem(T.writable(agent), args)),
  );

  reg(
    "set_output_systems",
    {
      title: "アウトプットの System",
      description: "アウトプットで動かす System と実行順（並べた順）を決める",
      inputSchema: {
        output: z.string().optional(),
        systems: z.array(z.object({ system: z.string(), enabled: z.boolean().optional() })),
      },
    },
    (args) => run(() => T.setOutputSystems(T.writable(agent), args)),
  );

  reg(
    "create_material",
    {
      title: "Material を作る",
      description: "Material を作る（Mesh の material フィールドで使う）",
      inputSchema: {
        name: z.string().min(1).max(64),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        roughness: z.number().min(0).max(1).optional(),
        metalness: z.number().min(0).max(1).optional(),
        map: z.string().optional().describe("色のテクスチャ（画像の素材の ID か、一意な名前）"),
      },
    },
    (args) => run(() => T.createMaterial(T.writable(agent), args)),
  );

  reg(
    "update_material",
    {
      title: "Material を変える",
      description:
        "名前・色・粗さ・金属度・色のテクスチャを変える。map を null にするとテクスチャを外す",
      inputSchema: {
        material: z.string().describe("Material の ID か名前"),
        name: z.string().min(1).max(64).optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        roughness: z.number().min(0).max(1).optional(),
        metalness: z.number().min(0).max(1).optional(),
        map: z.string().nullable().optional().describe("画像の ID か一意な名前。null で外す"),
      },
    },
    (args) => run(() => T.updateMaterial(T.writable(agent), args)),
  );

  reg(
    "import_asset",
    {
      title: "素材を取り込む",
      description:
        "GLB・PNG・JPEG・WebP・MP3・OGG・WAV を登録し、制作データの素材一覧に加える。data は base64。20MB まで",
      inputSchema: {
        name: z.string().min(1).max(64),
        contentType: z.enum([
          "model/gltf-binary",
          "image/png",
          "image/jpeg",
          "image/webp",
          "audio/mpeg",
          "audio/ogg",
          "audio/wav",
        ]),
        data: z
          .string()
          .min(1)
          .max(28 * 1024 * 1024)
          .describe("ファイルの base64"),
      },
    },
    (args) => run(() => T.importAsset(T.writable(agent), assets, args)),
  );

  reg(
    "check",
    {
      title: "問題を確かめる",
      description: "制作データの問題（名前・参照・System の import）を出す",
    },
    () =>
      run(async () => {
        const { project } = T.projectOf(agent);
        const { direct } = await T.resolvePackages(repos, agent.me, project.dependencies());
        const problems = await T.check(project, direct);
        return problems.length === 0 ? "問題はありません" : problems;
      }),
  );

  reg(
    "simulate",
    {
      title: "試しに動かす",
      description:
        "アウトプットをサーバーで決まった時間だけ動かし、System の状態（エラー）・ログ・Entity の状態を返す。人には見えない",
      inputSchema: {
        output: z.string().optional(),
        seconds: z.number().min(0).max(20).optional().describe("動かす秒数（既定 2、最大 20）"),
        inputs: z
          .array(
            z.object({
              at: z.number().min(0).describe("何秒目に入れるか"),
              action: z.string().max(32).describe("fire・use・reload など"),
              phase: z.enum(["down", "up"]).optional(),
              origin: vec3.optional(),
              direction: vec3.optional(),
            }),
          )
          .optional(),
        watch: z.array(z.string()).optional().describe("状態を返す Entity（省くと全部）"),
        equip: z
          .array(z.string())
          .optional()
          .describe("始める前に装備する道具（EquipmentTool の Entity）。fire などはこの道具に届く"),
      },
    },
    (args) =>
      run(async () => {
        const { project, workspaceId } = T.projectOf(agent);
        const { pool } = await T.resolvePackages(repos, agent.me, project.dependencies());
        return T.simulate(project, workspaceId, pool, args);
      }),
  );

  reg(
    "preview",
    {
      title: "視点から画面を撮る",
      description:
        "ワークスペースを開いている人の画面を、制作データの座標系の位置から、見る点の方を向いて撮る。再生中ならその画面、編集中なら制作データの見た目。人が開いていないと撮れない",
      inputSchema: {
        position: vec3.describe("カメラの位置"),
        target: vec3.describe("カメラが見る点"),
        fov: z.number().min(10).max(120).optional().describe("視野角（度）。省くと 70"),
      },
    },
    async ({ position, target, fov }) => {
      try {
        const { workspaceId } = T.projectOf(agent);
        const shot = await hub.requestCapture(workspaceId, { position, target, fov });
        const note = {
          mode: shot.mode,
          width: shot.width,
          height: shot.height,
          pending: shot.pending,
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(note, null, 2) },
            { type: "image" as const, data: shot.png, mimeType: "image/png" },
          ],
        };
      } catch (e) {
        return {
          ...text(e instanceof Error ? e.message : String(e)),
          isError: true,
        };
      }
    },
  );

  return { server, agent };
}

/** `/mcp` を足す（Streamable HTTP。MCP のセッションごとにエージェントを一人つくる） */
/** base64 にした 20MB の素材が入る大きさ。/mcp の POST だけ上げる */
const MCP_BODY_LIMIT = 28 * 1024 * 1024;

export function registerMcp(
  app: FastifyInstance,
  hub: Hub,
  repos: RepoService | null,
  assets: AssetStore,
) {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; agent: AgentClient }
  >();

  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.headers["mcp-session-id"];
    const existing = typeof id === "string" ? sessions.get(id) : undefined;
    if (existing) {
      reply.hijack();
      await existing.transport.handleRequest(req.raw, reply.raw, req.body);
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(req.body)) {
      return reply.code(400).send({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "MCP のセッションがありません（initialize から始めてください）",
        },
        id: null,
      });
    }
    const { server, agent } = createAgentMcp(hub, repos, assets);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, agent });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      agent.close();
    };
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post("/mcp", { bodyLimit: MCP_BODY_LIMIT }, handle);
  app.get("/mcp", handle);
  app.delete("/mcp", handle);
  app.addHook("onClose", async () => {
    for (const { transport } of sessions.values()) await transport.close();
    sessions.clear();
  });
}
