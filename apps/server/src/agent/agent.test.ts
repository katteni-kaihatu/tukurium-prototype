import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { gunAndTargetSample, ProjectDoc } from "@tukurium/repo-model";
import { PROTOCOL_VERSION, type ServerMessage } from "@tukurium/shared";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildApp } from "../app";
import { Hub } from "../hub";
import { MemoryStore } from "../store/store";
import { AgentClient } from "./AgentClient";

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
    expect(await call("check")).toBe("問題はありません");

    const result = await call("simulate", { seconds: 1, watch: ["回る箱"] });
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
});
