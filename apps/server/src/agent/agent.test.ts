import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  BUILTIN,
  emptyProject,
  expandPrefabs,
  extractInto,
  gunAndTargetSample,
  ProjectDoc,
  packageEntityId,
  packageManifest,
  packageResourceId,
} from "@tukurium/repo-model";
import { buildWorld, worldTransform } from "@tukurium/runtime";
import { PROTOCOL_VERSION, type ServerMessage } from "@tukurium/shared";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildApp } from "../app";
import { Hub } from "../hub";
import { RepoService } from "../repos/service";
import { MemoryStore, newUserId } from "../store/store";
import { AgentClient } from "./AgentClient";
import * as Tools from "./tools";

/** hub に内部でつなぐ人のクライアント（テスト用）。届いたメッセージを覚え、文書を同期する */
function human(hub: Hub, name: string) {
  const inbox: ServerMessage[] = [];
  const doc = new Y.Doc();
  const conn = hub.connect(
    {
      send: (raw) => {
        const m = JSON.parse(raw) as ServerMessage;
        inbox.push(m);
        if (m.t === "ws.doc" || m.t === "ws.update")
          Y.applyUpdate(doc, Buffer.from(m.update, "base64"), "remote");
      },
      close: () => {},
    },
    // 人の接続は、つなぐ時点でログインの本人が決まっている（ADR 0074）
    { user: { id: newUserId(), name } },
  );
  const send = (m: object) => conn.onMessage(JSON.stringify(m));
  const next = async <T extends ServerMessage["t"]>(t: T) => {
    for (let i = 0; i < 200; i++) {
      const at = inbox.findIndex((m) => m.t === t);
      if (at >= 0) return inbox.splice(at, 1)[0] as Extract<ServerMessage, { t: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout ${t}`);
  };
  send({ t: "hello", protocol: PROTOCOL_VERSION });
  return { send, next, inbox, doc, project: new ProjectDoc(doc), close: () => conn.onClose() };
}

/** 銃と的のサンプルを中身にした、Y.Doc の更新 */
function sampleUpdate(): string {
  const p = new ProjectDoc(new Y.Doc());
  p.load(gunAndTargetSample());
  return Buffer.from(Y.encodeStateAsUpdate(p.doc)).toString("base64");
}

async function roomWithWorkspace(hub: Hub, initial = sampleUpdate()) {
  const a = human(hub, "れにうむ");
  await a.next("welcome");
  a.send({ t: "session.create", name: "作業部屋" });
  const session = (await a.next("session")).session;
  a.send({ t: "ws.create", name: "銃と的", initial });
  const { workspaceId } = await a.next("ws.created");
  await a.next("ws.doc");
  return { a, sessionId: session.id, workspaceId };
}

describe("サーバーの中のエージェント（ADR 0054）", () => {
  it("プレハブの操作でも、閲覧だけの権限・ライブラリ・無効な相手を断る", () => {
    const project = new ProjectDoc(new Y.Doc());
    project.load(gunAndTargetSample());
    expect(() =>
      Tools.writable({ workspace: { id: "w", role: "viewer", project } } as AgentClient),
    ).toThrow(/閲覧だけ/);
    const local = Tools.createPrefab(project, { name: "部品" });
    const dependency = { packageId: "w_library", version: 1, alias: "lib", contentHash: "h" };
    const library = packageResourceId(dependency, local.id);
    const libraryOutput = project.addOutput("部品集", "library");
    project.setIncluded(libraryOutput, local.id, true);
    const manifest = packageManifest(project.snapshot(), libraryOutput);
    project.addDependency(dependency);
    Tools.setProjectPackages(project, [{ status: "ready", dependency, manifest }]);
    const libraryRoot = packageEntityId(dependency, local.root);
    // 取り込んだプレハブが ProjectDoc から読めても、元の定義を書き換えてはいけない。
    const before = project.snapshot();
    expect(() => Tools.updatePrefab(project, { prefab: library, name: "変更" })).toThrow(
      /ライブラリ/,
    );
    expect(() => Tools.createEntity(project, { prefab: library, name: "追加" })).toThrow(
      /ライブラリ/,
    );
    expect(() => Tools.updateEntity(project, { entity: libraryRoot, name: "変更" })).toThrow(
      /ライブラリ/,
    );
    expect(() => Tools.deleteEntity(project, libraryRoot)).toThrow(/ライブラリ/);
    expect(() => Tools.placePrefab(project, { prefab: "ないプレハブ" })).toThrow(/見つかりません/);
    expect(() =>
      Tools.createPrefab(project, { name: "空で残さない", systems: [{ system: "ないSystem" }] }),
    ).toThrow(/見つかりません/);
    expect(() =>
      Tools.updateEntity(project, { entity: local.root, parent: "ent_gun", name: "変更" }),
    ).toThrow(/いちばん上/);
    expect(project.snapshot()).toEqual(before);
  });

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

  it("ライブラリの型とプレハブを読み、配置・編集・再生・抽出・解除できる", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "tk-pkg-agent-"));
    const store = new MemoryStore();
    const repos = new RepoService(store, gitDir);
    const source = new ProjectDoc();
    source.load(emptyProject("ライブラリ"));
    const koko = source.addKokoState("Counter");
    source.updateKokoState({
      id: koko,
      name: "Counter",
      fields: [
        { id: "n", name: "n", type: "number", default: 2 },
        {
          id: "record",
          name: "record",
          type: "{ target: EntityRef; weights: number[] } | undefined",
          default: undefined,
        },
      ],
    });
    const prefab = source.addPrefab("共有の部品");
    const root = source.prefab(prefab)?.root;
    if (!root) throw new Error("ルートがありません");
    const child = source.addPrefabEntity({
      prefab,
      name: "芯",
      states: { [koko]: { n: 2, record: { target: root, weights: [1] } } },
    });
    const system = source.addSystem(
      "Step",
      'import Counter from "./Counter.koko"; export default system({ query: { with: [Counter] }, onUpdate(e) { e.get(Counter).n += 1; } });',
    );
    source.updatePrefab({
      ...source.prefab(prefab),
      id: prefab,
      name: "共有の部品",
      root,
      systems: [{ id: system, enabled: true }],
      keep: [],
    });
    const libraryOutput = source.addOutput("部品集", "library");
    source.setIncluded(libraryOutput, prefab, true);
    const owner = { id: "u_library", name: "作者" };
    const repo = await repos.create(owner, { name: "共有部品", snapshot: source.snapshot() });
    const work = await repos.publish(owner, repo.id, libraryOutput);
    const release = await repos.release(owner, work.id);
    const dependency = {
      alias: "parts",
      packageId: work.id,
      version: release.version,
      contentHash: release.contentHash ?? "",
    };
    const scene = new ProjectDoc();
    scene.load({ ...emptyProject("利用側"), dependencies: [dependency] });
    const app = await buildApp(
      {
        host: "127.0.0.1",
        port: 0,
        clientDir: undefined,
        databaseUrl: undefined,
        s3: undefined,
        assetDir: await mkdtemp(join(tmpdir(), "tk-assets-")),
        misskeyUrl: "https://misskey.example",
        devLogin: false,
        gitDir,
      },
      { store, hub: { saveDelayMs: 10 } },
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("アドレスがありません");
    const hub = (app as unknown as { tukuriumHub: Hub }).tukuriumHub;
    const { a, sessionId, workspaceId } = await roomWithWorkspace(
      hub,
      Buffer.from(Y.encodeStateAsUpdate(scene.doc)).toString("base64"),
    );
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text: string }[])[0]?.text ?? "";
      if (result.isError) throw new Error(text);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    await call("join_session", { sessionId });
    const opened = await call("open_workspace", { workspaceId });
    const prefabId = packageResourceId(dependency, prefab);
    const kokoId = packageResourceId(dependency, koko);
    expect(opened.project.prefabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: prefabId })]),
    );
    const placed = await call("place_prefab", { prefab: prefabId, name: "配置した部品" });
    const inside = `${placed.id}/${packageEntityId(dependency, child)}`;
    const target = await call("create_entity", { name: "参照先" });
    await call("update_entity", {
      entity: inside,
      states: { [kokoId]: { n: 9, record: { target: "参照先", weights: [2, 3] } } },
    });
    expect((await call("get_entity", { entity: inside })).states.Counter.record).toEqual({
      target: target.id,
      weights: [2, 3],
    });
    await expect(
      call("update_entity", {
        entity: inside,
        states: { [kokoId]: { record: { target: "参照先", weights: ["bad"] } } },
      }),
    ).rejects.toThrow(/使えない値/);
    await expect(call("update_prefab", { prefab: prefabId, name: "変更" })).rejects.toThrow(
      /ライブラリ/,
    );
    await expect(call("update_kokostate", { kokostate: kokoId, name: "変更" })).rejects.toThrow(
      /ライブラリ/,
    );
    await expect(
      call("update_entity", { entity: packageEntityId(dependency, child), name: "変更" }),
    ).rejects.toThrow(/ライブラリ/);
    await expect(call("apply_prefab_instance", { entity: placed.id })).rejects.toThrow(
      /ライブラリ/,
    );
    expect(await call("check")).toBe("問題はありません");
    const simulated = await call("simulate", { seconds: 1 / 60, watch: [inside] });
    expect(simulated.entities[0].states.Counter.n).toBe(10);
    expect(simulated.systems[0].error).toBeNull();
    await expect.poll(() => a.project.entity(placed.id)?.prefabOverrides).not.toBeUndefined();
    expect(a.project.snapshot().prefabs).toEqual([]);
    const sourceRepo = await repos.create(owner, {
      name: "抽出元",
      snapshot: a.project.snapshot(),
    });
    const imported = await repos.importSource(owner, sourceRepo.id);
    const extracted = extractInto(
      imported.snapshot,
      { outputs: ["out_main"], kokostates: [], systems: [], materials: [], assets: [] },
      { repoId: sourceRepo.id, repoName: "抽出元", commit: imported.commit },
      imported.snapshot,
      "抽出後",
      imported.schemas,
    );
    const roundtrip = new ProjectDoc();
    roundtrip.load(extracted);
    const { pool } = await Tools.resolvePackages(repos, owner, roundtrip.dependencies());
    Tools.setProjectPackages(roundtrip, pool);
    const copiedInstance = roundtrip
      .entities()
      .find((e) => e.instanceOf?.prefab === prefabId && e.id !== placed.id);
    if (!copiedInstance) throw new Error("抽出後のインスタンスがありません");
    const copiedTarget = roundtrip.entities(copiedInstance.output).find((e) => e.name === "参照先");
    const copiedInside = `${copiedInstance.id}/${packageEntityId(dependency, child)}`;
    expect(Tools.entityDetail(roundtrip, copiedInside).states.Counter?.record).toEqual({
      target: copiedTarget?.id,
      weights: [2, 3],
    });
    expect(copiedTarget?.id).not.toBe(target.id);
    expect(roundtrip.snapshot().prefabs).toEqual([]);
    const unpacked = await call("unpack_prefab_instance", { entity: placed.id });
    expect((await call("get_entity", { entity: placed.id })).instanceOf).toBeUndefined();
    const moved = unpacked.moved.find((m: { from: string }) => m.from === inside);
    expect((await call("get_entity", { entity: moved.to })).states.Counter.n).toBe(9);
    expect((await repos.snapshot(repo.id)).prefabs).toEqual(source.snapshot().prefabs);
    await client.close();
    a.close();
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
        misskeyUrl: "https://misskey.example",
        devLogin: false,
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

    // TypeScript で書いた型のフィールド（ADR 0065）。値は、保存する形（タグ付きの JSON）で渡す
    await call("create_kokostate", {
      name: "Hand",
      fields: [
        { name: "cards", type: "{ suit: string; rank: number; owner: EntityRef | undefined }[]" },
        { name: "drawn", type: "Date | undefined" },
        { name: "score", type: "Map<string, number>" },
        { name: "broken", type: "() => void" },
      ],
    });
    const hand = () => a.project.kokostates().find((k) => k.name === "Hand");
    await expect
      .poll(() => hand()?.fields.map((f) => f.default))
      .toEqual([[], undefined, new Map(), undefined]);
    await call("update_entity", {
      entity: "回る箱",
      states: {
        Hand: {
          cards: [{ suit: "spade", rank: 1, owner: "回る箱" }],
          drawn: { $t: "Date", v: "2026-11-10T00:00:00.000Z" },
          score: { $t: "Map", v: [["a", 3]] },
        },
      },
    });
    const box = () => a.project.entities().find((e) => e.name === "回る箱");
    // 値はフィールドの ID で入るので、名前に直して確かめる
    const handValues = () => {
      const values = box()?.states[hand()?.id ?? ""] ?? {};
      return Object.fromEntries((hand()?.fields ?? []).map((f) => [f.name, values[f.id]]));
    };
    await expect.poll(handValues).toMatchObject({
      // 入れ子の中の参照も、名前から ID になる
      cards: [{ suit: "spade", rank: 1, owner: box()?.id }],
      drawn: new Date("2026-11-10T00:00:00.000Z"),
      score: new Map([["a", 3]]),
    });
    await expect(
      call("update_entity", { entity: "回る箱", states: { Hand: { cards: [{ suit: 1 }] } } }),
    ).rejects.toThrow(/\[0\]\.suit：文字ではありません/);
    // 入れ子の中でも、ない名前の参照は入らない
    await expect(
      call("update_entity", {
        entity: "回る箱",
        states: { Hand: { cards: [{ suit: "spade", rank: 1, owner: "ない箱" }] } },
      }),
    ).rejects.toThrow(/見つかりません/);
    // 保存できない型は、そのフィールドの型エラーとして出る
    const typeProblems = await call("check");
    expect(typeProblems.map((p: { code: string }) => p.code)).toEqual(["field-type-unsaveable"]);
    await call("update_kokostate", {
      kokostate: "Hand",
      fields: [
        { name: "cards", type: "{ suit: string; rank: number; owner: EntityRef | undefined }[]" },
        { name: "drawn", type: "Date | undefined" },
        { name: "score", type: "Map<string, number>" },
      ],
    });
    await call("update_entity", {
      entity: "回る箱",
      states: { Hand: { cards: [{ suit: "spade", rank: 1, owner: box()?.id }] } },
    });
    expect(await call("check")).toBe("問題はありません");

    // 型の定義を作り、KokoState のフィールドの型から使う（ADR 0065）
    await call("create_typedef", {
      name: "Cards",
      code: 'export type Card = { suit: "spade" | "heart"; rank: number };\n',
    });
    await call("create_kokostate", {
      name: "Deck",
      typeDefs: ["Cards"],
      fields: [
        { name: "cards", type: "Card[]", default: [{ suit: "heart", rank: 2 }] },
        { name: "byName", type: "Record<string, Card>" },
        { name: "gun", type: "KokoStateRef<Gun> | undefined" },
        { name: "ammo", type: "FieldRef<number> | undefined" },
      ],
    });
    const deck = () => a.project.kokostates().find((k) => k.name === "Deck");
    await expect
      .poll(() => deck()?.fields.map((f) => f.default))
      .toEqual([[{ suit: "heart", rank: 2 }], {}, undefined, undefined]);
    // 初期値が型に合わなければ、KokoState を作らない
    await expect(
      call("create_kokostate", {
        name: "Bad",
        typeDefs: ["Cards"],
        fields: [{ name: "cards", type: "Card[]", default: [{ suit: "club", rank: 1 }] }],
      }),
    ).rejects.toThrow(/\[0\]\.suit/);
    expect((await call("get_project")).kokostates.map((k: { name: string }) => k.name)).toEqual([
      "Gun",
      "Target",
      "Spinner",
      "Hand",
      "Deck",
    ]);
    // KokoState の参照・フィールドの参照は、Entity・KokoState・フィールドを名前で渡せる（保存されるのは ID）
    await call("update_entity", {
      entity: "回る箱",
      states: {
        Deck: {
          byName: { ace: { suit: "spade", rank: 1 } },
          gun: { entity: "銃", koko: "Gun" },
          ammo: { entity: "銃", koko: "Gun", field: "ammo" },
        },
      },
    });
    const deckValues = () => {
      const values = box()?.states[deck()?.id ?? ""] ?? {};
      return Object.fromEntries((deck()?.fields ?? []).map((f) => [f.name, values[f.id]]));
    };
    await expect.poll(deckValues).toEqual({
      cards: [{ suit: "heart", rank: 2 }],
      byName: { ace: { suit: "spade", rank: 1 } },
      gun: { entity: "ent_gun", koko: "ks_gun" },
      ammo: { entity: "ent_gun", koko: "ks_gun", field: "f_ammo" },
    });
    // 指せない KokoState の参照・ないフィールドの参照は入らない
    await expect(
      call("update_entity", {
        entity: "回る箱",
        states: { Deck: { gun: { entity: "的1", koko: "Target" } } },
      }),
    ).rejects.toThrow(/フィールド「gun」.*に使えない値です/);
    await expect(
      call("update_entity", {
        entity: "回る箱",
        states: { Deck: { ammo: { entity: "銃", koko: "Gun", field: "nope" } } },
      }),
    ).rejects.toThrow(/見つかりません/);
    expect(await call("check")).toBe("問題はありません");
    // 要約と、型の定義の中身が読める
    const summary = await call("get_project");
    expect(summary.typeDefs).toEqual([expect.objectContaining({ name: "Cards" })]);
    expect(summary.kokostates.find((k: { name: string }) => k.name === "Deck").typeDefs).toEqual([
      "Cards",
    ]);
    expect(await call("get_typedef", { typedef: "Cards" })).toMatchObject({
      name: "Cards",
      code: expect.stringContaining("export type Card"),
      usedBy: ["Deck"],
    });
    // 型の定義にフィールドを足しても、すでにある値は問題にならない（空の値で埋めて使う）。名前も変えられる
    await call("update_typedef", {
      typedef: "Cards",
      name: "Trumps",
      code: 'export type Card = { suit: "spade" | "heart"; rank: number; joker: boolean };\n',
    });
    expect(await call("check")).toBe("問題はありません");
    expect((await call("get_typedef", { typedef: "Trumps" })).usedBy).toEqual(["Deck"]);
    // 型が変わった所は、値の問題として出る（初期値と、Entity の cards・byName）
    await call("update_typedef", {
      typedef: "Trumps",
      code: "export type Card = { suit: number; rank: number };\n",
    });
    expect((await call("check")).map((p: { code: string }) => p.code).sort()).toEqual([
      "default-type-mismatch",
      "value-type-mismatch",
      "value-type-mismatch",
    ]);
    await call("update_typedef", {
      typedef: "Trumps",
      code: 'export type Card = { suit: "spade" | "heart"; rank: number };\n',
    });
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

    // 空から作り、中身を変え、同じプレハブを二つ置く。人の文書にも届く。
    const prefab = await call("create_prefab", { name: "回る部品", systems: [{ system: "Spin" }] });
    const child = await call("create_entity", {
      prefab: prefab.id,
      name: "部品の箱",
      states: {
        Transform: { position: [0, 1, 0] },
        Mesh: { shape: "box" },
        Spinner: { speed: 20 },
      },
    });
    await call("update_entity", { entity: child.id, states: { Spinner: { speed: 40 } } });
    await call("update_prefab", { prefab: prefab.id, name: "回転部品", editIn: "isolated" });
    const first = await call("place_prefab", {
      prefab: prefab.id,
      name: "部品1",
      position: [1, 0, 0],
      rotation: [0, 90, 0],
      scale: [2, 2, 2],
    });
    const second = await call("place_prefab", { prefab: "回転部品", name: "部品2" });
    const read = await call("get_prefab", { prefab: prefab.id });
    expect(read).toMatchObject({
      name: "回転部品",
      editIn: "isolated",
      systems: [{ enabled: true }],
    });
    expect(read.entities.find((e: { id: string }) => e.id === child.id).states.Spinner.speed).toBe(
      40,
    );
    expect((await call("get_entity", { entity: first.id })).states.Transform).toMatchObject({
      position: [1, 0, 0],
      rotation: [0, 90, 0],
      scale: [2, 2, 2],
    });
    await expect.poll(() => a.project.prefab(prefab.id)?.name).toBe("回転部品");
    const expanded = expandPrefabs(a.project.snapshot());
    const spinner = a.project.kokostates().find((k) => k.name === "Spinner");
    if (!spinner) throw new Error("Spinner がありません");
    expect(
      expanded.entities.find((e) => e.id === `${first.id}/${child.id}`)?.states[spinner.id],
    ).toEqual(
      expanded.entities.find((e) => e.id === `${second.id}/${child.id}`)?.states[spinner.id],
    );
    const inside = `${first.id}/${child.id}`;
    await call("update_entity", {
      entity: inside,
      name: "この配置の箱",
      states: { Spinner: { speed: 55 } },
      index: 0,
    });
    expect((await call("get_entity", { entity: inside })).states.Spinner.speed).toBe(55);
    expect(
      (await call("get_entity", { entity: `${second.id}/${child.id}` })).states.Spinner.speed,
    ).toBe(40);
    expect((await call("get_entity", { entity: inside })).origin.prefab).toBe(prefab.id);
    await expect(call("delete_entity", { entity: inside })).rejects.toThrow(/消せません/);
    await expect(
      call("update_entity", { entity: inside, removeStates: ["Spinner"] }),
    ).rejects.toThrow(/外せません/);
    await call("revert_prefab_change", {
      entity: inside,
      kind: "field",
      kokostate: "Spinner",
      field: "speed",
    });
    await call("revert_prefab_change", { entity: inside, kind: "name" });
    expect((await call("get_entity", { entity: inside })).states.Spinner.speed).toBe(40);
    const duplicate = await call("duplicate_entity", { entity: first.id, name: "複製した配置" });
    expect(duplicate.instanceOf.prefab).toBe(prefab.id);
    const batchDuplicate = await call("apply_entities", {
      ops: [{ op: "duplicate", entity: first.id, copies: [{}] }],
    });
    expect(batchDuplicate[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("duplicate_entity"),
    });
    const independent = await call("duplicate_entity", { entity: inside, name: "独立した箱" });
    expect(independent.instanceOf).toBeUndefined();
    expect(independent.states.Spinner.speed).toBe(40);
    await call("create_kokostate", {
      name: "Highlight",
      fields: [{ name: "level", type: "number", default: 0 }],
    });
    await call("update_entity", { entity: inside, states: { Highlight: { level: 3 } } });
    expect((await call("get_entity", { entity: inside })).states.Highlight.level).toBe(3);
    await call("revert_prefab_change", { entity: inside, kind: "state", kokostate: "Highlight" });
    expect((await call("get_entity", { entity: inside })).states.Highlight).toBeUndefined();
    await call("set_instance_systems", {
      entity: first.id,
      systems: [{ system: "Spin", enabled: false }],
    });
    expect((await call("get_entity", { entity: first.id })).instanceSystems).toHaveLength(1);
    await call("revert_prefab_change", { entity: first.id, kind: "systems" });
    expect((await call("get_entity", { entity: first.id })).instanceSystems).toBeUndefined();
    await call("update_entity", { entity: inside, states: { Spinner: { speed: 80 } } });
    const appliedPrefab = await call("apply_prefab_instance", { entity: first.id });
    expect(appliedPrefab.prefab).toBe(prefab.id);
    expect(
      (await call("get_entity", { entity: `${second.id}/${child.id}` })).states.Spinner.speed,
    ).toBe(80);
    const unpackedPrefab = await call("unpack_prefab_instance", { entity: first.id });
    expect(unpackedPrefab.moved).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: inside })]),
    );
    expect((await call("get_entity", { entity: first.id })).instanceOf).toBeUndefined();
    await call("update_entity", { entity: child.id, states: { Spinner: { speed: 90 } } });
    expect(
      (await call("get_entity", { entity: `${second.id}/${child.id}` })).states.Spinner.speed,
    ).toBe(90);
    const unpackedChild = unpackedPrefab.moved.find((m: { from: string }) => m.from === inside).to;
    expect((await call("get_entity", { entity: unpackedChild })).states.Spinner.speed).toBe(80);
    await expect(call("delete_entity", { entity: prefab.root })).rejects.toThrow(/いちばん上/);
    await expect(
      call("create_entity", { name: "誤り", prefab: prefab.id, output: "射撃場" }),
    ).rejects.toThrow(/同時/);
    // 変換は、親の ID を保ち、子の対応とコード中の注意を返す。
    const origin = await call("create_entity", { name: "変換元", states: { Transform: {} } });
    const originalChild = await call("create_entity", {
      name: "変換する子",
      parent: origin.id,
      states: { Mesh: { shape: "box" } },
    });
    const converted = await call("make_prefab_from_entity", { entity: origin.id });
    expect(converted.moved).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: originalChild.id })]),
    );
    expect((await call("get_entity", { entity: origin.id })).instanceOf.prefab).toBe(
      converted.prefab.id,
    );
    // プレハブの中にも置ける。循環は断り、中の Entity からも部品を作れる。
    const board = await call("create_prefab", { name: "盤" });
    const nested = await call("place_prefab", {
      prefab: prefab.id,
      ownerPrefab: board.id,
      name: "盤の部品",
    });
    expect((await call("get_entity", { entity: nested.id })).prefab).toBe(board.id);
    await expect(
      call("place_prefab", { prefab: board.id, ownerPrefab: prefab.id }),
    ).rejects.toThrow(/自分自身/);
    await expect(
      call("place_prefab", { prefab: prefab.id, ownerPrefab: board.id, output: "射撃場" }),
    ).rejects.toThrow(/同時/);
    const boardPart = await call("create_entity", {
      name: "盤から作る部品",
      prefab: board.id,
      states: { Mesh: { shape: "box" } },
    });
    const convertedInside = await call("make_prefab_from_entity", { entity: boardPart.id });
    expect(convertedInside.owner).toEqual({ kind: "prefab", id: board.id });
    expect(await call("check")).toBe("問題はありません");

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
        misskeyUrl: "https://misskey.example",
        devLogin: false,
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
