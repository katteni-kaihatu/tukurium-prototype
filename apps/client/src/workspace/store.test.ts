import { World } from "@tukurium/eks";
import { buildRegistry, DebugSettingsDoc, emptyProject, ProjectDoc } from "@tukurium/repo-model";
import { Simulation } from "@tukurium/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const fake = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  return {
    messages: new Set<(message: unknown) => void>(),
    welcomes: new Set<() => void>(),
    send: vi.fn(),
  };
});
vi.mock("../app/store", () => ({
  useApp: {
    getState: () => ({
      myName: "test",
      client: {
        send: fake.send,
        on: (fn: (message: unknown) => void) => {
          fake.messages.add(fn);
          return () => fake.messages.delete(fn);
        },
        onWelcome: (fn: () => void) => {
          fake.welcomes.add(fn);
          return () => fake.welcomes.delete(fn);
        },
      },
    }),
  },
}));
vi.mock("./packages", () => ({ resolvePackagePool: vi.fn(), resolvePackages: vi.fn() }));
vi.mock("@tukurium/runtime", () => ({ Simulation: { create: vi.fn() } }));

import { resolvePackagePool } from "./packages";
import { useWorkspace } from "./store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const receive = (message: unknown) => {
  for (const fn of fake.messages) fn(message);
};
const command = (cmd: "play" | "stop", outputId = useWorkspace.getState().outputId) =>
  receive({ t: "ws.cmd", workspaceId: "w_test", cmd, outputId });
function simulation() {
  return {
    world: new World(buildRegistry([])),
    time: 0,
    dispose: vi.fn(),
    systemStatus: () => [],
    bagsSnapshot: () => ({}),
    partEntitiesSnapshot: () => ({}),
    restore: vi.fn(),
    restoreBags: vi.fn(),
    nameOf: (id: string) => id,
  } as unknown as Simulation;
}

it("再接続した共同編集者は未送信のデバッグ設定を再送する", () => {
  const project = useWorkspace.getState().project;
  if (!project) throw new Error("project missing");
  const debug = new DebugSettingsDoc(project);
  debug.setEnabled(true);
  useWorkspace.setState({ debug, debugReady: true, role: "editor" });
  const server = new Y.Doc();
  receive({
    t: "ws.debugDoc",
    workspaceId: "w_test",
    full: true,
    update: Buffer.from(Y.encodeStateAsUpdate(server)).toString("base64"),
  });
  expect(useWorkspace.getState().debug?.read().enabled).toBe(true);
  const sent = fake.send.mock.calls.map((c) => c[0]).find((m) => m.t === "ws.debugUpdate");
  expect(sent).toBeDefined();
  Y.applyUpdate(server, Buffer.from(sent.update, "base64"));
  expect(server.getMap("settings").get("enabled")).toBe(true);
  server.destroy();
});

it("再接続で閲覧権限になったら未送信のデバッグ設定を捨てる", () => {
  const project = useWorkspace.getState().project;
  if (!project) throw new Error("project missing");
  const debug = new DebugSettingsDoc(project);
  debug.setEnabled(true);
  useWorkspace.setState({ debug, debugReady: true, role: "viewer" });
  const server = new Y.Doc();
  receive({
    t: "ws.debugDoc",
    workspaceId: "w_test",
    full: true,
    update: Buffer.from(Y.encodeStateAsUpdate(server)).toString("base64"),
  });
  expect(useWorkspace.getState().debug?.read().enabled).toBe(false);
  expect(fake.send.mock.calls.some((c) => c[0].t === "ws.debugUpdate")).toBe(false);
  server.destroy();
});

it("全パネルを隠していても共有の停止パネルを開く", () => {
  useWorkspace.setState({ isHost: false, panelsHidden: true, debugOpen: false });
  receive({
    t: "ws.frame",
    workspaceId: "w_test",
    frame: {
      mode: "paused",
      outputId: "out1",
      time: 0,
      world: { entities: [] },
      names: {},
      status: [],
      partEntities: {},
      debug: { id: "stop", systemId: "s", line: 1, entity: null, frames: [], reason: "一時停止" },
    },
  });
  expect(useWorkspace.getState().debugOpen).toBe(true);
  expect(useWorkspace.getState().panelsHidden).toBe(false);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePackagePool).mockReset().mockResolvedValue([]);
  vi.mocked(Simulation.create)
    .mockReset()
    .mockImplementation(async () => simulation());
  const project = new ProjectDoc();
  project.load({
    ...emptyProject("v1"),
    outputs: [
      { id: "out1", name: "first", kind: "item", systems: [], keep: [] },
      { id: "out2", name: "second", kind: "item", systems: [], keep: [] },
    ],
  });
  useWorkspace.setState({
    ...useWorkspace.getInitialState(),
    workspaceId: "w_test",
    project,
    isHost: true,
    ready: true,
    outputId: "out1",
  });
});
afterEach(() => {
  const project = useWorkspace.getState().project;
  useWorkspace.getState().leave();
  project?.doc.destroy();
});

describe("Play の非同期開始 (#66)", () => {
  it.each(["dependencies", "simulation"] as const)(
    "ホスト引き継ぎの %s 待ち中に編集が届いても再生を復元する",
    async (phase) => {
      const packages = deferred<Awaited<ReturnType<typeof resolvePackagePool>>>();
      const building = deferred<Simulation>();
      const sim = simulation();
      if (phase === "dependencies")
        vi.mocked(resolvePackagePool).mockImplementationOnce(() => packages.promise);
      else vi.mocked(Simulation.create).mockImplementationOnce(() => building.promise);
      const resume = {
        mode: "play",
        outputId: "out1",
        time: 12,
        world: { entities: [] },
        names: {},
        status: [],
        bags: {},
        partEntities: {},
      };
      useWorkspace.setState({ isHost: false, mode: "play" });
      receive({ t: "ws.host", workspaceId: "w_test", resume });
      await flush();
      const project = useWorkspace.getState().project;
      const unobserve = project?.observe(() => useWorkspace.setState((s) => ({ rev: s.rev + 1 })));
      project?.setName("ホスト引き継ぎ中の編集");
      unobserve?.();
      if (phase === "dependencies") {
        vi.mocked(Simulation.create).mockResolvedValueOnce(sim);
        packages.resolve([]);
      } else building.resolve(sim);
      await flush();
      expect(useWorkspace.getState()).toMatchObject({ mode: "play", sim, isHost: true });
      expect(vi.mocked(sim.restore).mock.calls[0]?.slice(0, 3)).toEqual([
        resume.world,
        resume.names,
        12,
      ]);
      expect(sim.dispose).not.toHaveBeenCalled();
    },
  );

  it("遅い旧版の Play が、新版の再生と Stop を上書きしない", async () => {
    const first = deferred<Awaited<ReturnType<typeof resolvePackagePool>>>();
    vi.mocked(resolvePackagePool).mockImplementationOnce(() => first.promise);
    command("play");
    useWorkspace.getState().setOutput("out2");
    useWorkspace.getState().project?.setName("v2");
    command("play");
    await flush();
    expect(useWorkspace.getState()).toMatchObject({ mode: "play", outputId: "out2" });
    expect(vi.mocked(Simulation.create).mock.calls[0]?.[0].name).toBe("v2");
    command("stop");
    expect(useWorkspace.getState()).toMatchObject({ mode: "edit", sim: null });
    first.resolve([]);
    await flush();
    expect(useWorkspace.getState()).toMatchObject({ mode: "edit", sim: null, outputId: "out2" });
    expect(Simulation.create).toHaveBeenCalledTimes(1);
  });

  it("作成まで進んだ古い Simulation は破棄し、新しい再生を残す", async () => {
    const first = deferred<Simulation>();
    const oldSim = simulation();
    const newSim = simulation();
    vi.mocked(Simulation.create)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(newSim);
    command("play");
    await flush();
    command("play", "out2");
    await flush();
    expect(useWorkspace.getState()).toMatchObject({ mode: "play", sim: newSim, outputId: "out2" });
    const sent = fake.send.mock.calls.length;
    const logs = useWorkspace.getState().logs.length;
    vi.mocked(Simulation.create).mock.calls[0]?.[2]?.onLog?.({
      time: 0,
      systemId: null,
      level: "log",
      message: "古い開始のログ",
    });
    first.resolve(oldSim);
    await flush();
    expect(oldSim.dispose).toHaveBeenCalledOnce();
    expect(newSim.dispose).not.toHaveBeenCalled();
    expect(useWorkspace.getState()).toMatchObject({ mode: "play", sim: newSim, outputId: "out2" });
    expect(fake.send).toHaveBeenCalledTimes(sent);
    expect(useWorkspace.getState().logs).toHaveLength(logs);
  });

  it("Stop を送った時点で、作成中の Simulation も取り消す", async () => {
    const pending = deferred<Simulation>();
    const sim = simulation();
    vi.mocked(Simulation.create).mockImplementationOnce(() => pending.promise);
    command("play");
    await flush();
    // サーバーからの Stop の折り返しを待たずに取り消す。
    useWorkspace.getState().stop();
    pending.resolve(sim);
    await flush();
    expect(useWorkspace.getState()).toMatchObject({ mode: "edit", sim: null });
    expect(sim.dispose).toHaveBeenCalledOnce();
  });

  it("出力を切り替えて元に戻しても、切替前の開始は復活しない", async () => {
    const pending = deferred<Awaited<ReturnType<typeof resolvePackagePool>>>();
    vi.mocked(resolvePackagePool).mockImplementationOnce(() => pending.promise);
    command("play");
    useWorkspace.getState().setOutput("out2");
    useWorkspace.getState().setOutput("out1");
    pending.resolve([]);
    await flush();
    expect(useWorkspace.getState()).toMatchObject({ mode: "edit", sim: null, outputId: "out1" });
    expect(Simulation.create).not.toHaveBeenCalled();
  });

  it("同じワークスペースへ再接続してホストに戻っても、接続前の開始は復活しない", async () => {
    const pending = deferred<Awaited<ReturnType<typeof resolvePackagePool>>>();
    vi.mocked(resolvePackagePool).mockImplementationOnce(() => pending.promise);
    command("play");
    for (const welcome of fake.welcomes) welcome();
    receive({ t: "ws.host", workspaceId: "w_test", resume: null });
    pending.resolve([]);
    await flush();
    expect(useWorkspace.getState()).toMatchObject({ mode: "edit", sim: null, isHost: true });
    expect(Simulation.create).not.toHaveBeenCalled();
  });

  it("同じ ID のワークスペースを開き直しても、以前の開始は復活しない", async () => {
    const pending = deferred<Awaited<ReturnType<typeof resolvePackagePool>>>();
    vi.mocked(resolvePackagePool).mockImplementationOnce(() => pending.promise);
    const project = useWorkspace.getState().project;
    command("play");
    useWorkspace.getState().leave();
    useWorkspace.getState().open("w_test");
    receive({ t: "ws.host", workspaceId: "w_test", resume: null });
    pending.resolve([]);
    await flush();
    expect(useWorkspace.getState()).toMatchObject({ mode: "edit", sim: null, isHost: true });
    expect(Simulation.create).not.toHaveBeenCalled();
    project?.doc.destroy();
  });
});

describe("ワークスペースを閉じる", () => {
  it("閉じる頼みはサーバーへ送り、自分は残る", () => {
    useWorkspace.getState().end();
    expect(fake.send).toHaveBeenCalledWith({ t: "ws.end", workspaceId: "w_test" });
    expect(useWorkspace.getState().workspaceId).toBe("w_test");
  });

  it("閉じられたら自分も出て、理由が残る", () => {
    const project = useWorkspace.getState().project;
    receive({
      t: "ws.ended",
      workspaceId: "w_test",
      reason: "れにうむ がワークスペースを閉じました",
    });
    expect(useWorkspace.getState().workspaceId).toBeNull();
    expect(useWorkspace.getState().error).toMatch(/閉じました/);
    expect(fake.send).toHaveBeenCalledWith({ t: "ws.close", workspaceId: "w_test" });
    project?.doc.destroy();
  });
});

describe("プレハブを開く（ADR 0076）", () => {
  function prefabs() {
    const project = useWorkspace.getState().project;
    if (!project) throw new Error("ワークスペースが開かれていません");
    const prefab = project.addPrefab("的");
    const root = project.prefab(prefab)?.root ?? "";
    const core = project.addPrefabEntity({ prefab, name: "芯" });
    const inst = project.addInstance({ output: "out1", prefab });
    return { project, prefab, root, core, inst };
  }
  const state = () => useWorkspace.getState();

  it("開くと、編集の対象がプレハブになる。戻ると、開いた元のインスタンスを選ぶ", () => {
    const { prefab, inst } = prefabs();
    state().openPrefab(prefab, inst);
    expect(state()).toMatchObject({
      editingPrefab: { id: prefab, from: inst },
      selection: { kind: "prefab", id: prefab },
      outputId: "out1",
    });
    state().closePrefab();
    expect(state()).toMatchObject({
      editingPrefab: null,
      selection: { kind: "entity", id: inst },
    });
    // Resources から開いたときは、アウトプットを選んだ所へ戻る
    state().openPrefab(prefab);
    state().closePrefab();
    expect(state().selection).toEqual({ kind: "output", id: "out1" });
    // ないプレハブは開かない
    state().openPrefab("pf_none");
    expect(state().editingPrefab).toBeNull();
  });

  it("選んだものに合わせて、プレハブを開く・閉じる", () => {
    const { prefab, core, inst } = prefabs();
    // プレハブの中の Entity を選ぶと、そのプレハブが開く
    state().select({ kind: "entity", id: core });
    expect(state().editingPrefab).toEqual({ id: prefab, from: null });
    // 何も選ばなくても、開いたまま
    state().select(null);
    expect(state().editingPrefab?.id).toBe(prefab);
    // アウトプットの Entity（インスタンスの中の Entity も）を選ぶと、アウトプットに戻る
    state().select({ kind: "entity", id: `${inst}/${core}` });
    expect(state().editingPrefab).toBeNull();
    state().openPrefab(prefab);
    state().select({ kind: "output", id: "out1" });
    expect(state().editingPrefab).toBeNull();
  });

  it("アウトプットを切り替えると、プレハブを閉じる", () => {
    const { prefab } = prefabs();
    state().openPrefab(prefab);
    state().setOutput("out2");
    expect(state()).toMatchObject({
      editingPrefab: null,
      outputId: "out2",
      selection: { kind: "output", id: "out2" },
    });
  });

  it("Play を始めると、アウトプットに戻る。再生中は開けない", async () => {
    const { prefab, core } = prefabs();
    state().openPrefab(prefab);
    state().select({ kind: "entity", id: core });
    command("play");
    await flush();
    expect(state()).toMatchObject({ mode: "play", editingPrefab: null, selection: null });
    state().openPrefab(prefab);
    state().select({ kind: "entity", id: core });
    expect(state().editingPrefab).toBeNull();
    command("stop");
    expect(state()).toMatchObject({ mode: "edit", editingPrefab: null });
  });

  it("ワークスペースを開き直す・出ると、閉じた状態に戻る。開いていたプレハブが消えたら、アウトプットに戻る", () => {
    const { project, prefab } = prefabs();
    state().openPrefab(prefab);
    state().leave();
    expect(state().editingPrefab).toBeNull();
    project.doc.destroy();
    // 開いたワークスペースでは、制作データの変更を見ている
    state().open("w_other");
    const opened = state().project;
    if (!opened) throw new Error("ワークスペースが開かれていません");
    opened.load(emptyProject("v2"));
    const made = opened.addPrefab("箱");
    state().openPrefab(made);
    expect(state().editingPrefab?.id).toBe(made);
    opened.removePrefab(made);
    expect(state()).toMatchObject({ editingPrefab: null, selection: null });
  });
});
