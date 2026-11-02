import { type EntityId, World } from "@tukurium/eks";
import { buildRegistry, ProjectDoc, type ProjectSnapshot } from "@tukurium/repo-model";
import { type InputEvent, type LogEntry, Simulation, type SystemStatus } from "@tukurium/runtime";
import type { PlayFrame, PlayMode, WorkspaceRole } from "@tukurium/shared";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { create } from "zustand";
import { useApp } from "../app/store";
import { WorkspaceSync } from "./WorkspaceSync";

export type Selection =
  | { kind: "entity"; id: string }
  | { kind: "output"; id: string }
  | { kind: "koko"; id: string }
  | { kind: "system"; id: string }
  | { kind: "material"; id: string };

export type Mode = PlayMode;
export type WorkspaceLog = LogEntry & { seq: number };

/** 再生中の World と名前（ホストなら手元の Simulation、それ以外はホストから届いた状態） */
export interface RuntimeView {
  world: World;
  nameOf(id: EntityId): string;
}

interface WorkspaceState {
  workspaceId: string | null;
  project: ProjectDoc | null;
  awareness: Awareness | null;
  /** 自分の権限。null は未参加 */
  role: WorkspaceRole | null;
  /** 自分がこのワークスペースのホスト（再生を実行する人）か */
  isHost: boolean;
  /** 中身を受け取り終えたか */
  ready: boolean;
  error: string | null;

  rev: number;
  outputId: string;
  selection: Selection | null;
  mode: Mode;
  /** ホストのときだけ：実行中の Simulation */
  sim: Simulation | null;
  /** ホスト以外：ホストから届いた実行状態 */
  remote: { world: World; names: Record<string, string> } | null;
  simRev: number;
  systemStatus: SystemStatus[];
  logs: WorkspaceLog[];
  openSystems: string[];
  activeSystem: string | null;
  panelsHidden: boolean;
  viewPoint: (() => [number, number, number]) | null;

  create(name: string, snap: ProjectSnapshot): void;
  open(workspaceId: string): void;
  leave(): void;
  select(sel: Selection | null): void;
  setOutput(id: string): void;
  play(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  input(ev: InputEvent): void;
  openSystem(id: string): void;
  closeSystem(id: string): void;
  togglePanels(): void;
  clearLogs(): void;
  runtime(): RuntimeView | null;
}

const MAX_LOGS = 200;
let seq = 0;
let sync: WorkspaceSync | null = null;
let unobserve: (() => void) | null = null;

const client = () => useApp.getState().client;

/**
 * いま開いているワークスペース。
 * - 制作データは Y.Doc をサーバーと同期する（WorkspaceSync）。
 * - 再生はホストだけが実行し（sim）、ほかの人はホストから届く状態（remote）を表示する。
 *   再生の操作はすべてサーバー経由でホストに届ける（ホスト自身の操作も同じ経路）。
 */
export const useWorkspace = create<WorkspaceState>((set, get) => {
  const command = (cmd: "play" | "pause" | "resume" | "stop") => {
    const { workspaceId, outputId } = get();
    if (!workspaceId) return;
    client().send({ t: "ws.cmd", workspaceId, cmd, outputId });
  };

  return {
    workspaceId: null,
    project: null,
    awareness: null,
    role: null,
    isHost: false,
    ready: false,
    error: null,
    rev: 0,
    outputId: "",
    selection: null,
    mode: "edit",
    sim: null,
    remote: null,
    simRev: 0,
    systemStatus: [],
    logs: [],
    openSystems: [],
    activeSystem: null,
    panelsHidden: false,
    viewPoint: null,

    create: (name, snap) => {
      const doc = new ProjectDoc();
      doc.load(snap);
      client().send({ t: "ws.create", name, initial: toB64(Y.encodeStateAsUpdate(doc.doc)) });
    },

    open: (workspaceId) => {
      if (get().workspaceId === workspaceId) return;
      get().leave();
      const project = new ProjectDoc(new Y.Doc());
      const awareness = new Awareness(project.doc);
      awareness.setLocalStateField("user", {
        name: useApp.getState().myName,
        color: "#603d56",
        colorLight: "#f3eaf0",
      });
      sync = new WorkspaceSync(client(), workspaceId, project.doc, awareness);
      unobserve = project.observe(() => {
        const s = get();
        // アウトプットが消えたら別のものに切り替える
        const outputs = s.project?.outputs() ?? [];
        const outputId = outputs.some((o) => o.id === s.outputId)
          ? s.outputId
          : (outputs[0]?.id ?? "");
        set({ rev: s.rev + 1, outputId });
      });
      set({
        workspaceId,
        project,
        awareness,
        role: null,
        isHost: false,
        ready: false,
        error: null,
        selection: null,
        mode: "edit",
        remote: null,
        logs: [],
        openSystems: [],
        activeSystem: null,
      });
      client().send({ t: "ws.open", workspaceId });
    },

    leave: () => {
      const { workspaceId, sim, awareness } = get();
      if (!workspaceId) return;
      client().send({ t: "ws.close", workspaceId });
      sim?.dispose();
      sync?.dispose();
      sync = null;
      unobserve?.();
      unobserve = null;
      awareness?.destroy();
      set({
        workspaceId: null,
        project: null,
        awareness: null,
        role: null,
        isHost: false,
        ready: false,
        sim: null,
        remote: null,
        mode: "edit",
        selection: null,
        openSystems: [],
        activeSystem: null,
      });
    },

    select: (selection) => set({ selection }),

    setOutput: (outputId) => {
      if (get().mode !== "edit") get().stop();
      set({ outputId, selection: { kind: "output", id: outputId } });
    },

    play: () => command("play"),
    pause: () => command("pause"),
    resume: () => command("resume"),
    stop: () => command("stop"),

    input: (ev) => {
      const { isHost, sim, workspaceId } = get();
      if (isHost && sim) sim.input(ev);
      else if (workspaceId) client().send({ t: "ws.input", workspaceId, input: ev });
    },

    openSystem: (id) =>
      set((s) => ({
        openSystems: s.openSystems.includes(id) ? s.openSystems : [...s.openSystems, id],
        activeSystem: id,
      })),

    closeSystem: (id) =>
      set((s) => {
        const openSystems = s.openSystems.filter((x) => x !== id);
        return {
          openSystems,
          activeSystem: s.activeSystem === id ? (openSystems.at(-1) ?? null) : s.activeSystem,
        };
      }),

    togglePanels: () => set((s) => ({ panelsHidden: !s.panelsHidden })),
    clearLogs: () => set({ logs: [] }),

    runtime: () => {
      const { sim, remote } = get();
      if (sim) return { world: sim.world, nameOf: (id) => sim.nameOf(id) };
      if (remote) return { world: remote.world, nameOf: (id) => remote.names[id] ?? id };
      return null;
    },
  };
});

// ---------------------------------------------------------------------------
// サーバーからのメッセージ

const ws = () => useWorkspace.getState();
const set = useWorkspace.setState;
const pushLog = (entry: LogEntry) =>
  set((s) => ({ logs: [...s.logs, { ...entry, seq: seq++ }].slice(-MAX_LOGS) }));
const log = (message: string, level: LogEntry["level"] = "log") =>
  pushLog({ time: ws().sim?.time ?? 0, systemId: null, message, level });

client().on((msg) => {
  const s = ws();
  switch (msg.t) {
    case "ws.created":
      s.open(msg.workspaceId);
      return;
    case "ws.doc": {
      if (msg.workspaceId !== s.workspaceId || !s.project) return;
      sync?.receiveFull(fromB64(msg.update), msg.role !== "viewer");
      const outputs = s.project.outputs();
      set({
        role: msg.role,
        ready: true,
        outputId: outputs.some((o) => o.id === s.outputId) ? s.outputId : (outputs[0]?.id ?? ""),
      });
      return;
    }
    case "ws.update":
      if (msg.workspaceId === s.workspaceId) sync?.receive(fromB64(msg.update));
      return;
    case "ws.awareness":
      if (msg.workspaceId === s.workspaceId) sync?.receiveAwareness(fromB64(msg.update));
      return;
    case "ws.denied":
      if (msg.workspaceId !== s.workspaceId) return;
      s.leave();
      set({ error: msg.reason });
      return;
    case "ws.role":
      if (msg.workspaceId !== s.workspaceId) return;
      if (msg.role === null) {
        s.leave();
        set({ error: "このワークスペースを閲覧する権限がなくなりました" });
      } else {
        set({ role: msg.role });
      }
      return;
    case "ws.host":
      if (msg.workspaceId !== s.workspaceId) return;
      set({ isHost: true, remote: null });
      log("このワークスペースの再生は、あなたが実行します（ホスト）");
      if (msg.resume && msg.resume.mode !== "edit") void startSim(msg.resume.outputId, msg.resume);
      return;
    case "ws.cmd":
      if (msg.workspaceId === s.workspaceId && s.isHost) void hostCommand(msg.cmd, msg.outputId);
      return;
    case "ws.input":
      if (msg.workspaceId === s.workspaceId && s.isHost) s.sim?.input(msg.input);
      return;
    case "ws.frame":
      if (msg.workspaceId === s.workspaceId && !s.isHost) applyFrame(msg.frame);
      return;
    case "ws.log":
      if (msg.workspaceId === s.workspaceId) log(msg.message, msg.level);
      return;
    case "session.closed":
      s.leave();
      return;
  }
});

// 接続し直したら、開いていたワークスペースを開き直す（セッションへの再参加は SessionView が先に行う）
client().onWelcome(() => {
  const id = ws().workspaceId;
  if (!id) return;
  ws().sim?.dispose();
  set({ isHost: false, ready: false, sim: null, remote: null, mode: "edit" });
  setTimeout(() => client().send({ t: "ws.open", workspaceId: id }), 0);
});

// ---------------------------------------------------------------------------
// ホストの処理

async function hostCommand(cmd: "play" | "pause" | "resume" | "stop", outputId?: string) {
  const s = ws();
  switch (cmd) {
    case "play":
      if (s.mode === "edit") await startSim(outputId ?? s.outputId, null);
      return;
    case "pause":
      if (s.mode === "play") set({ mode: "paused" });
      sendFrame();
      return;
    case "resume":
      if (s.mode === "paused") set({ mode: "play" });
      sendFrame();
      return;
    case "stop":
      s.sim?.dispose();
      set({ sim: null, mode: "edit", systemStatus: [] });
      sendFrame();
      return;
  }
}

async function startSim(outputId: string, resume: PlayFrame | null) {
  const s = ws();
  if (!s.project || !s.workspaceId) return;
  s.sim?.dispose();
  const workspaceId = s.workspaceId;
  const sim = await Simulation.create(s.project.snapshot(), outputId, {
    // 同じワークスペース（＝同じリポジトリ）の System は同じ領域で動かす
    realm: workspaceId,
    onLog: (entry) => {
      pushLog(entry);
      client().send({ t: "ws.log", workspaceId, message: entry.message, level: entry.level });
    },
  });
  if (ws().workspaceId !== workspaceId || !ws().isHost) {
    sim.dispose();
    return;
  }
  if (resume?.world) {
    sim.restore(resume.world as Parameters<Simulation["restore"]>[0], resume.names, resume.time);
  }
  set({
    sim,
    outputId,
    mode: resume?.mode === "paused" ? "paused" : "play",
    systemStatus: sim.systemStatus(),
  });
  log(resume ? "前のホストの状態から再生を続けます" : "Play を開始しました");
  sendFrame();
}

/** ホストが実行状態を配信する（WorkspaceController が間隔を見て呼ぶ） */
export function sendFrame(): void {
  const s = ws();
  if (!s.isHost || !s.workspaceId) return;
  const sim = s.sim;
  const frame: PlayFrame = sim
    ? {
        mode: s.mode,
        outputId: s.outputId,
        time: sim.time,
        world: sim.world.snapshot(),
        names: Object.fromEntries(sim.world.entityIds().map((id) => [id, sim.nameOf(id)])),
        status: sim.systemStatus(),
      }
    : { mode: "edit", outputId: s.outputId, time: 0, world: null, names: {}, status: [] };
  client().send({ t: "ws.frame", workspaceId: s.workspaceId, frame });
}

function applyFrame(frame: PlayFrame) {
  const s = ws();
  if (frame.mode === "edit" || !frame.world || !s.project) {
    set({ mode: "edit", remote: null, systemStatus: [] });
    return;
  }
  const world = s.remote?.world ?? new World(buildRegistry(s.project.kokostates()));
  world.restore(frame.world as Parameters<World["restore"]>[0]);
  set((st) => ({
    mode: frame.mode,
    outputId: frame.outputId || st.outputId,
    remote: { world, names: frame.names },
    systemStatus: frame.status,
    simRev: st.simRev + 1,
  }));
}

function toB64(u: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u.length; i += 0x8000)
    bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// 開発時のみ：E2E テストやデバッグからストアを参照できるようにする
if (import.meta.env.DEV)
  (window as { __workspace?: typeof useWorkspace }).__workspace = useWorkspace;
