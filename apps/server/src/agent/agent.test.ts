import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BUILTIN, gunAndTargetSample, ProjectDoc } from "@tukurium/repo-model";
import { buildWorld, worldTransform } from "@tukurium/runtime";
import { PROTOCOL_VERSION, type ServerMessage } from "@tukurium/shared";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildApp } from "../app";
import { Hub } from "../hub";
import { MemoryStore } from "../store/store";
import { AgentClient } from "./AgentClient";
import * as Tools from "./tools";

/** hub に内部でつなぐ人のクライアント（テスト用）。届いたメッセージを覚え、文書を同期する */
function human(hub: Hub, name: string) {
  const inbox: ServerMessage[] = [];
  const doc = new Y.Doc();
  const conn = hub.connect({
    send: (raw) => {
      const m = JSON.parse(raw) as ServerMessage;
      inbox.push(m);
      if (m.t === "ws.doc" || m.t === "ws.update")
        Y.applyUpdate(doc, Buffer.from(m.update, "base64"), "remote");
    },
    close: () => {},
  });
  const send = (m: object) => conn.onMessage(JSON.stringify(m));
  const next = async <T extends ServerMessage["t"]>(t: T) => {
    for (let i = 0; i < 200; i++) {
      const at = inbox.findIndex((m) => m.t === t);
      if (at >= 0) return inbox.splice(at, 1)[0] as Extract<ServerMessage, { t: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout ${t}`);
  };
  send({ t: "hello", protocol: PROTOCOL_VERSION, name });
  return { send, next, inbox, doc, project: new ProjectDoc(doc), close: () => conn.onClose() };
}

/** 銃と的のサンプルを中身にした、Y.Doc の更新 */
function sampleUpdate(): string {
  const p = new ProjectDoc(new Y.Doc());
  p.load(gunAndTargetSample());
  return Buffer.from(Y.encodeStateAsUpdate(p.doc)).toString("base64");
}

async function roomWithWorkspace(hub: Hub) {
  const a = human(hub, "れにうむ");
  await a.next("welcome");
  a.send({ t: "session.create", name: "作業部屋" });
  const session = (await a.next("session")).session;
  a.send({ t: "ws.create", name: "銃と的", initial: sampleUpdate() });
  const { workspaceId } = await a.next("ws.created");
  await a.next("ws.doc");
  return { a, sessionId: session.id, workspaceId };
}

describe("サーバーの中のエージェント（ADR 0054）", () => {
  it("人と同じ道で入って編集し、人に届く。保存はできず、ホストにもならない", async () => {
    const hub = new Hub(new MemoryStore(), { saveDelayMs: 10 });
    const { a, sessionId, workspaceId } = await roomWithWorkspace(hub);
    const agent = new AgentClient(hub);
    await agent.hello("れにうむ");
    expect(agent.me?.name).toBe("エージェント（れにうむ）");
    await agent.joinSession(sessionId);
    const w = await agent.openWorkspace(workspaceId);
    expect(w.project.entities().some((e) => e.name === "銃")).toBe(true);

    // エージェントの編集が人の文書に届く
    const gun = w.project.entities().find((e) => e.name === "銃");
    w.project.renameEntity(gun?.id ?? "", "鉄砲");
    await agent.settle();
    expect(a.project.entities().some((e) => e.name === "鉄砲")).toBe(true);
    // 人の編集もエージェントに届く
    a.project.renameEntity(gun?.id ?? "", "銃");
    a.send({
      t: "ws.update",
      workspaceId,
      update: Buffer.from(Y.encodeStateAsUpdate(a.doc)).toString("base64"),
    });
    await agent.settle();
    expect(w.project.entity(gun?.id ?? "")?.name).toBe("銃");

    // 保存は断られる
    (agent as unknown as { send(m: object): void }).send({
      t: "ws.commit",
      workspaceId,
      message: "勝手に保存",
    });
    expect((await agent.settle()).join()).toMatch(/エージェントは保存できません/);

    // 人が抜けても、エージェントはホストにならない
    a.send({ t: "ws.close", workspaceId });
    await agent.settle();
    const info = agent.session?.workspaces.find((x) => x.id === workspaceId);
    expect(info?.host).toBeNull();
    agent.close();
    a.close();
  });
});

describe("リモートの MCP（/mcp）", () => {
  let close: (() => Promise<unknown>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it("MCP の道具で、入って・作って・確かめて・動かせる", async () => {
    const app = await buildApp(
      {
        host: "127.0.0.1",
        port: 0,
        clientDir: undefined,
        databaseUrl: undefined,
        s3: undefined,
        assetDir: await mkdtemp(join(tmpdir(), "tk-assets-")),
        gitDir: await mkdtemp(join(tmpdir(), "tk-git-")),
      },
      { store: new MemoryStore(), hub: { saveDelayMs: 10 } },
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const hub = (app as unknown as { tukuriumHub: Hub }).tukuriumHub;
    const { a, sessionId, workspaceId } = await roomWithWorkspace(hub);

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`)),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      const text = r.content[0]?.text ?? "";
      if (r.isError) throw new Error(text);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["guide", "join_session", "simulate"]));
    expect(await call("guide")).toMatch(/System の書き方/);
    expect((await call("list_sessions"))[0]).toMatchObject({ id: sessionId });
    await call("join_session", { sessionId, name: "テスト" });
    const opened = await call("open_workspace", { workspaceId });
    expect(opened.project.outputs[0].name).toBe("射撃場");

    // KokoState・Entity・System を作る
    await call("create_kokostate", {
      name: "Spinner",
      fields: [{ name: "speed", type: "number", default: 90 }],
    });
    await call("create_entity", {
      name: "回る箱",
      states: {
        Transform: { position: [0, 1, -3] },
        Mesh: { shape: "box" },
        Spinner: { speed: 180 },
      },
    });
    await call("create_system", {
      name: "Spin",
      code: `import Spinner from "./Spinner.koko";
import Transform from "@builtin/Transform.koko";
export default system({
  query: { with: [Spinner, Transform] },
  onUpdate(e, dt) {
    const t = e.get(Transform);
    t.rotation = [0, t.rotation[1] + e.get(Spinner).speed * dt, 0];
  },
});
`,
    });
    // 人の画面に届いている
    await expect.poll(() => a.project.entities().some((e) => e.name === "回る箱")).toBe(true);

    // 参照の「なし」は undefined（ADR 0065）。見るときは {"$t":"undefined"}、外すときは null でもよい
    const meshOf = () =>
      a.project.entities().find((e) => e.name === "回る箱")?.states[BUILTIN.Mesh];
    expect((await call("get_entity", { entity: "回る箱" })).states.Mesh.material).toEqual({
      $t: "undefined",
    });
    await call("create_material", { name: "赤", color: "#ff0000" });
    await call("update_entity", { entity: "回る箱", states: { Mesh: { material: "赤" } } });
    await expect.poll(() => typeof meshOf()?.material).toBe("string");
    await call("update_entity", { entity: "回る箱", states: { Mesh: { material: null } } });
    await expect.poll(() => meshOf()?.material).toBeUndefined();
    expect(Object.keys(meshOf() ?? {})).toContain("material");
    await call("update_entity", { entity: "回る箱", states: { Mesh: { material: "赤" } } });
    await call("update_entity", {
      entity: "回る箱",
      states: { Mesh: { material: { $t: "undefined" } } },
    });
    await expect.poll(() => meshOf()?.material).toBeUndefined();
    expect(await call("check")).toBe("問題はありません");

    const result = await call("simulate", { seconds: 1, watch: ["回る箱"] });
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(1);
    expect(result.systems.every((s: { error?: string }) => !s.error)).toBe(true);
    const rot = result.entities[0].states.Transform.rotation[1];
    expect(rot).toBeGreaterThan(170);
    expect(rot).toBeLessThan(190);

    // 道具を装備して撃つと、弾が減る
    const shot = await call("simulate", {
      seconds: 0.5,
      equip: ["銃"],
      inputs: [{ at: 0.05, action: "fire", origin: [0, 1.1, 3.6], direction: [0, 0, -1] }],
      watch: ["銃"],
    });
    expect(shot.entities[0].states.Gun.ammo).toBe(11);

    // 型の誤りも check で返る（人と同じ。ADR 0058）。型の誤りがあっても simulate は動く
    await call("create_system", {
      name: "Typo",
      code: `import Spinner from "./Spinner.koko";
export default system({
  query: { with: [Spinner] },
  onUpdate(e) { e.get(Spinner).sped = 1; },
});
`,
    });
    const problems = await call("check");
    expect(problems).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "ts2551",
        location: expect.objectContaining({ kind: "script", line: 4 }),
        message: expect.stringContaining("sped"),
      }),
    ]);

    // 間違えると、直せる形で返る
    await expect(call("get_entity", { entity: "ない箱" })).rejects.toThrow(/見つかりません/);
    await client.close();
    a.close();
  });

  it("まとめて作り、素材を貼り、開いている画面を撮る", async () => {
    const app = await buildApp(
      {
        host: "127.0.0.1",
        port: 0,
        clientDir: undefined,
        databaseUrl: undefined,
        s3: undefined,
        assetDir: await mkdtemp(join(tmpdir(), "tk-assets-")),
        gitDir: await mkdtemp(join(tmpdir(), "tk-git-")),
      },
      { store: new MemoryStore(), hub: { saveDelayMs: 10 } },
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const hub = (app as unknown as { tukuriumHub: Hub }).tukuriumHub;
    const { a, sessionId, workspaceId } = await roomWithWorkspace(hub);

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`)),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text?: string; data?: string; mimeType?: string }[];
        isError?: boolean;
      };
      const text = r.content.find((c) => c.type === "text")?.text ?? "";
      if (r.isError) throw new Error(text);
      try {
        return { value: JSON.parse(text) as Record<string, unknown>, raw: r };
      } catch {
        return { value: text, raw: r };
      }
    };

    await call("join_session", { sessionId, name: "テスト" });
    await call("open_workspace", { workspaceId });

    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await expect(
      call("import_asset", {
        name: "壊れた画像",
        contentType: "image/png",
        data: Buffer.from("hello").toString("base64"),
      }),
    ).rejects.toThrow(/種類と違います/);
    const imported = await call("import_asset", {
      name: "木目",
      contentType: "image/png",
      data: png,
    });
    expect(imported.value).toMatchObject({ name: "木目", kind: "image" });
    const material = await call("create_material", {
      name: "木肌",
      color: "#8a5a3a",
      roughness: 0.8,
      map: "木目",
    });
    expect(material.value).toMatchObject({ name: "木肌" });
    expect(await call("check")).toEqual({ value: "問題はありません", raw: expect.anything() });

    const updatesBefore = a.inbox.filter((m) => m.t === "ws.update").length;
    const applied = await call("apply_entities", {
      ops: [
        {
          op: "create",
          ref: "trunk",
          name: "木",
          states: { Transform: { position: [0, 0, 0], rotation: [0, 90, 0] } },
        },
        {
          op: "create",
          ref: "leaf",
          name: "樹冠",
          parent: "trunk",
          states: {
            Transform: { position: [1, 0, 0] },
            Mesh: { shape: "sphere", material: "木肌" },
          },
        },
        { op: "update", entity: "ない箱", name: "失敗" },
        { op: "duplicate", entity: "trunk", copies: [{ position: [5, 0, 0] }] },
      ],
    });
    const results = applied.value as unknown as {
      ok: boolean;
      op: string;
      id?: string;
      name?: string;
      error?: string;
      copies?: {
        id: string;
        name: string;
        entities: { id: string; name: string; parent: string | null }[];
      }[];
    }[];
    expect(results.map((r) => r.ok)).toEqual([true, true, false, true]);
    expect(results[2]?.error).toMatch(/見つかりません/);
    expect(results[3]?.name).toMatch(/のコピー/);
    const copy = results[3]?.copies?.[0];
    const copyLeaf = copy?.entities.find((e) => e.name === "樹冠");
    expect(copyLeaf?.parent).toBe(copy?.id);
    await expect
      .poll(() => a.inbox.filter((m) => m.t === "ws.update").length)
      .toBe(updatesBefore + 1);
    await expect.poll(() => a.project.entities().some((e) => e.name === "木")).toBe(true);
    expect(a.project.entities().some((e) => e.name === "失敗")).toBe(false);

    const leaf = await call("get_entity", { entity: copyLeaf?.id ?? "" });
    const leafValue = leaf.value as { states: { Transform: { position: number[] } } };
    expect(leafValue.states.Transform.position[0]).toBeCloseTo(1);
    expect(leafValue.states.Transform.position[1]).toBeCloseTo(0);

    const renamed = await call("update_entity", { entity: "木", name: "親木" });
    expect(renamed.value).toMatchObject({ name: "親木" });

    const found = await call("get_entities", { name: "樹冠", material: "木肌" });
    const foundValue = found.value as {
      total: number;
      truncated: boolean;
      entities: { name: string; worldPosition: number[] }[];
    };
    expect(foundValue.truncated).toBe(false);
    expect(foundValue.total).toBe(foundValue.entities.length);
    expect(foundValue.entities.every((e) => e.name === "樹冠")).toBe(true);
    const original = foundValue.entities.find((e) => Math.abs((e.worldPosition[0] ?? 0) - 5) > 1);
    expect(original).toBeTruthy();
    const built = buildWorld(a.project.snapshot(), a.project.outputs()[0]?.id ?? "");
    const originalId = a.project
      .entities()
      .find((e) => e.name === "樹冠" && e.parent !== copy?.id)?.id;
    const expected = worldTransform(built.world, originalId ?? "");
    expect(original?.worldPosition[0]).not.toBeCloseTo(1);
    expect(original?.worldPosition[0]).toBeCloseTo(expected.position.x);
    expect(original?.worldPosition[2]).toBeCloseTo(expected.position.z);

    const shotWait = (async () => {
      for (let i = 0; i < 200; i++) {
        const msg = a.inbox.find((m) => m.t === "ws.capture");
        if (msg?.t === "ws.capture") {
          a.send({
            t: "ws.shot",
            workspaceId: msg.workspaceId,
            requestId: msg.requestId,
            png,
            pending: false,
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("撮影の依頼が来ませんでした");
    })();
    const preview = client.callTool({
      name: "preview",
      arguments: { position: [0, 1.6, 6], target: [0, 0, 0] },
    });
    await shotWait;
    const shot = (await preview) as {
      content: { type: string; text?: string; mimeType?: string }[];
      isError?: boolean;
    };
    expect(shot.isError).toBeFalsy();
    expect(shot.content.some((c) => c.type === "image" && c.mimeType === "image/png")).toBe(true);
    expect(shot.content.find((c) => c.type === "text")?.text).toMatch(/"mode": "edit"/);

    const sessionsBefore = a.inbox.filter((m) => m.t === "session").length;
    a.send({ t: "ws.close", workspaceId });
    await expect
      .poll(() => a.inbox.filter((m) => m.t === "session").length)
      .toBeGreaterThan(sessionsBefore);
    await expect(call("preview", { position: [0, 1.6, 6], target: [0, 0, 0] })).rejects.toThrow(
      /開いている人/,
    );

    await client.close();
    a.close();
  });
});

describe("件数を隠さない", () => {
  it("get_entities と simulate は、切ったときも全体の件数を返す", async () => {
    const project = new ProjectDoc(new Y.Doc());
    const output = project.addOutput("森", "world");
    for (let i = 0; i < 201; i++) project.addEntity({ output, name: `木${i}` });
    const listed = Tools.getEntities(project, {});
    expect(listed.truncated).toBe(true);
    expect(listed.total).toBe(201);
    expect(listed.entities).toHaveLength(200);

    const simulated = await Tools.simulate(project, "w", [], { seconds: 0 });
    expect(simulated.truncated).toBe(true);
    expect(simulated.total).toBe(201);
    expect(simulated.entities).toHaveLength(200);

    const small = new ProjectDoc(new Y.Doc());
    small.addOutput("空き地", "world");
    const quiet = await Tools.simulate(small, "w", [], { seconds: 0 });
    expect(quiet.truncated).toBe(false);
    expect(quiet.total).toBe(0);
  });
});
