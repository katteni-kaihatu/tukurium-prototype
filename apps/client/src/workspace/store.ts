import { type EntityId, World } from "@tukurium/eks";
import {
  buildRegistry,
  type Diagnostic,
  type ObservedDiagnostics,
  type PackageResolution,
  ProjectDoc,
  type ProjectSnapshot,
} from "@tukurium/repo-model";
import {
  type BagItem,
  type EffectEvent,
  type InputEvent,
  type LogEntry,
  Simulation,
  type SoundEvent,
  type SystemStatus,
} from "@tukurium/runtime";
import type { PlayFrame, PlayMode, WorkspaceRole } from "@tukurium/shared";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { create } from "zustand";
import { useApp } from "../app/store";
import type { WorkspaceAnchor } from "./anchor";
import { resolvePackagePool } from "./packages";
import { mergeRun, runDiagnostics, scriptLine } from "./problems";
import { WorkspaceSync } from "./WorkspaceSync";

/** Hierarchy で選んだもの。Inspector の右側に出る */
export type Selection = { kind: "entity"; id: string } | { kind: "output"; id: string };

/** KokoState・マテリアル・スクリプト。Inspector とは別の詳細パネルで開く */
export type DetailTarget = { kind: "koko" | "system" | "material"; id: string };

const NO_DIAGNOSTICS: ObservedDiagnostics = { diagnostics: [], observedVersion: 0 };

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
  /** 依存の中身（別名 → 取り出した結果。ADR 0015）。usePackageDefinitions が更新する */
  packages: ReadonlyMap<string, PackageResolution>;
  /** 依存の依存の中身も含めた集まり（別の版が混ざっていないかを見るのに使う） */
  packagePool: readonly PackageResolution[];
  outputId: string;
  selection: Selection | null;
  /** 開いている詳細（KokoState・マテリアル・スクリプト）。null ならパネルを出さない */
  detail: (DetailTarget & { seq: number }) | null;
  mode: Mode;
  /** ホストのときだけ：実行中の Simulation */
  sim: Simulation | null;
  /** ホスト以外：ホストから届いた実行状態 */
  remote: {
    world: World;
    names: Record<string, string>;
    /** プレイヤー → バッグ（再生中。ADR 0018） */
    bags: Record<string, BagItem[]>;
  } | null;
  simRev: number;
  systemStatus: SystemStatus[];
  /** 編集中の確認で見つかった問題（構文など）。System ごとに、調べたときの版（rev）と組で持つ */
  checkProblems: ObservedDiagnostics[];
  /** 実行して止まった System と、Play を始めたときの版（次の Play まで残す。Stop しても消さない） */
  runProblems: ObservedDiagnostics;
  /** エディタで開いて、その行へ移る（seq は同じ行へ何度でも移れるように） */
  jumpTo: { systemId: string; line: number | null; seq: number } | null;
  /** 問題の場所をエディタで開く */
  showProblem(p: Diagnostic): void;
  logs: WorkspaceLog[];
  openSystems: string[];
  activeSystem: string | null;
  panelsHidden: boolean;
  viewPoint: (() => [number, number, number]) | null;
  /** ホストから届いた、まだ鳴らしていない音（ホスト以外） */
  incomingSounds: SoundEvent[];
  /** ホストから届いた、まだ出していない一時的な effect（ホスト以外） */
  incomingEffects: EffectEvent[];
  /** セッションに出すときの置き場所：視線の先の床（セッションの座標）と、自分の向き */
  placePoint: (() => { position: [number, number, number]; yaw: number }) | null;
  /** 編集空間の置き場所（WorkspaceController が更新する） */
  anchor: WorkspaceAnchor | null;
  /** 独立した空間（space）とセッション（session）の間を移動する */
  teleport: ((to: "space" | "session") => void) | null;

  create(name: string, snap: ProjectSnapshot): void;
  /** リポジトリ（プロジェクト）をこのセッションのワークスペースとして開く */
  openRepo(repoId: string): void;
  /** コミットのたびに増える（履歴パネルの再読み込み用） */
  commitRev: number;
  /** セッションのライブラリ（作品を置く）パネルを開いているか */
  /** セッションに置いてあるものの一覧を開いているか */
  belongingsOpen: boolean;
  /** 自分のバッグのパネル（ADR 0018） */
  bagOpen: boolean;
  historyOpen: boolean;
  /** セッションに出す・適用・リンク先一覧のパネルを開いているか */
  sessionOpen: boolean;
  /** Inspector を開いているか。ワークスペースを開いたときは開いている */
  inspectorOpen: boolean;
  /** Resources を開いているか。ワークスペースを開いたときは開いている */
  resourcesOpen: boolean;
  /** エラーのパネルを開いているか */
  problemsOpen: boolean;
  /** 新しいエラーが出たときにエラーパネルを前に出すための合図（増えるたびに前に出る） */
  problemsFocus: number;
  /** ログ・保存のパネルを開いているか */
  logOpen: boolean;
  /** 保存パネルを開いているか */
  saveOpen: boolean;
  /** 保存パネルを前に出すため。開くたびに増やす */
  saveSeq: number;
  openSave(): void;
  open(workspaceId: string): void;
  leave(): void;
  select(sel: Selection | null): void;
  openDetail(target: DetailTarget): void;
  closeDetail(): void;
  setOutput(id: string): void;
  play(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  input(ev: InputEvent): void;
  openSystem(id: string): void;
  /**
   * 次に出すコードパネルの置き方。
   * Resources が 3D なら 3D、2D なら 2D。seq は同じ置き方を続けて頼んでも届くようにする。
   */
  editorPlace: { mode: "2d" | "3d"; seq: number } | null;
  placeEditor(mode: "2d" | "3d"): void;
  /** 詳細パネルも、開いた元のパネルと同じ置き方にする */
  detailPlace: { mode: "2d" | "3d"; seq: number } | null;
  placeDetail(mode: "2d" | "3d"): void;
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

/** 入力に、今の表示名を添える（すでに名前があればそのまま） */
function withPlayerName(ev: InputEvent): InputEvent {
  if (ev.playerName) return ev;
  const { me, myName } = useApp.getState();
  const playerName = me?.name || myName;
  return playerName ? { ...ev, playerName } : ev;
}

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
    packages: new Map(),
    packagePool: [],
    outputId: "",
    selection: null,
    detail: null,
    mode: "edit",
    sim: null,
    remote: null,
    simRev: 0,
    systemStatus: [],
    checkProblems: [],
    runProblems: NO_DIAGNOSTICS,
    jumpTo: null,
    showProblem: (p) => {
      if (p.subject.kind !== "system") return;
      const systemId = p.subject.id;
      get().openSystem(systemId);
      set((s) => ({
        jumpTo: { systemId, line: scriptLine(p), seq: (s.jumpTo?.seq ?? 0) + 1 },
      }));
    },
    logs: [],
    openSystems: [],
    activeSystem: null,
    editorPlace: null,
    detailPlace: null,
    panelsHidden: false,
    viewPoint: null,
    incomingSounds: [],
    incomingEffects: [],
    placePoint: null,
    anchor: null,
    teleport: null,

    commitRev: 0,
    belongingsOpen: false,
    bagOpen: false,
    historyOpen: false,
    sessionOpen: false,
    inspectorOpen: true,
    resourcesOpen: true,
    problemsOpen: false,
    problemsFocus: 0,
    logOpen: false,
    saveOpen: false,
    saveSeq: 0,
    openSave: () => set((s) => ({ saveOpen: true, saveSeq: s.saveSeq + 1 })),
    openRepo: (repoId) => client().send({ t: "ws.openRepo", repoId }),
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
        detail: null,
        packages: new Map(),
        packagePool: [],
        mode: "edit",
        remote: null,
        logs: [],
        openSystems: [],
        activeSystem: null,
        editorPlace: null,
        detailPlace: null,
        checkProblems: [],
        runProblems: NO_DIAGNOSTICS,
        jumpTo: null,
        sessionOpen: false,
        inspectorOpen: true,
        resourcesOpen: true,
        problemsOpen: false,
        problemsFocus: 0,
        logOpen: false,
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
        detail: null,
        packages: new Map(),
        packagePool: [],
        checkProblems: [],
        runProblems: NO_DIAGNOSTICS,
        jumpTo: null,
        openSystems: [],
        activeSystem: null,
        editorPlace: null,
        detailPlace: null,
        sessionOpen: false,
        inspectorOpen: true,
        resourcesOpen: true,
        problemsOpen: false,
        problemsFocus: 0,
        logOpen: false,
      });
    },

    select: (selection) => set({ selection }),

    openDetail: (target) => set((s) => ({ detail: { ...target, seq: (s.detail?.seq ?? 0) + 1 } })),

    closeDetail: () => set({ detail: null }),

    setOutput: (outputId) => {
      if (get().mode !== "edit") get().stop();
      set({ outputId, selection: { kind: "output", id: outputId } });
    },

    play: () => command("play"),
    pause: () => command("pause"),
    resume: () => command("resume"),
    stop: () => command("stop"),

    input: (ev) => {
      const named = withPlayerName(ev);
      const { isHost, sim, workspaceId } = get();
      if (isHost && sim) sim.input(named);
      else if (workspaceId) client().send({ t: "ws.input", workspaceId, input: named });
    },

    openSystem: (id) =>
      set((s) => ({
        openSystems: s.openSystems.includes(id) ? s.openSystems : [...s.openSystems, id],
        activeSystem: id,
      })),

    placeEditor: (mode) =>
      set((s) => ({ editorPlace: { mode, seq: (s.editorPlace?.seq ?? 0) + 1 } })),

    placeDetail: (mode) =>
      set((s) => ({ detailPlace: { mode, seq: (s.detailPlace?.seq ?? 0) + 1 } })),

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
    case "ws.committed":
      if (msg.workspaceId !== s.workspaceId) return;
      log(`${msg.by} がコミットしました：${msg.message}`);
      set((st) => ({ commitRev: st.commitRev + 1 }));
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
  const snapshot = s.project.snapshot();
  // 依存の中身（依存の依存も。ADR 0015）。取り出せない依存は、それを import した System が理由つきで止まる
  const packages = await resolvePackagePool(snapshot.dependencies ?? []);
  const sim = await Simulation.create(snapshot, outputId, {
    // 同じワークスペース（＝同じリポジトリ）の System は同じ領域で動かす
    realm: workspaceId,
    packages,
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
    sim.restore(
      resume.world as Parameters<Simulation["restore"]>[0],
      resume.names,
      resume.time,
      resume.partEntities,
    );
    sim.restoreBags(resume.bags as Record<string, BagItem[]> | undefined);
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

let outgoingEffects: EffectEvent[] = [];
/** ホストが出した一時的な effect を、次に配る状態に入れる */
export function queueOutgoingEffects(effects: EffectEvent[]): void {
  outgoingEffects = [...outgoingEffects, ...effects].slice(-32);
}

let outgoingSounds: SoundEvent[] = [];
/** ホストが鳴らした音を、次に配る状態に入れる */
export function queueOutgoingSounds(sounds: SoundEvent[]): void {
  outgoingSounds.push(...sounds);
  if (outgoingSounds.length > 32) outgoingSounds = outgoingSounds.slice(-32);
}

/** ホストが実行状態を配信する（WorkspaceController が間隔を見て呼ぶ） */
export function sendFrame(): void {
  const s = ws();
  if (!s.isHost || !s.workspaceId) return;
  const sim = s.sim;
  const sounds = outgoingSounds;
  outgoingSounds = [];
  const effects = outgoingEffects;
  outgoingEffects = [];
  const frame: PlayFrame = sim
    ? {
        sounds,
        effects,
        mode: s.mode,
        outputId: s.outputId,
        time: sim.time,
        world: sim.world.snapshot(),
        names: Object.fromEntries(sim.world.entityIds().map((id) => [id, sim.nameOf(id)])),
        status: sim.systemStatus(),
        bags: sim.bagsSnapshot(),
        partEntities: sim.partEntitiesSnapshot(),
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
    incomingSounds: [...st.incomingSounds, ...(frame.sounds ?? [])].slice(-32),
    incomingEffects: [...st.incomingEffects, ...(frame.effects ?? [])].slice(-32),
    mode: frame.mode,
    outputId: frame.outputId || st.outputId,
    remote: { world, names: frame.names, bags: (frame.bags ?? {}) as Record<string, BagItem[]> },
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

// 実行して止まった System を、Stop した後も「問題」に残す。次の Play で消す
// Play を始めた後に制作データを変えると、実行の問題は stale（編集前の結果）になる
useWorkspace.subscribe((s, prev) => {
  if (s.mode !== "edit" && prev.mode === "edit") {
    useWorkspace.setState({
      runProblems: { diagnostics: runDiagnostics(s.systemStatus), observedVersion: s.rev },
    });
  } else if (
    s.systemStatus !== prev.systemStatus &&
    s.systemStatus.some((x) => x.error || (x.warnings?.length ?? 0) > 0)
  ) {
    const next = runDiagnostics(s.systemStatus);
    const prevRun = s.runProblems.diagnostics;
    const changed = next.some(
      (d) => !prevRun.some((q) => q.fingerprint === d.fingerprint && q.message === d.message),
    );
    if (changed)
      useWorkspace.setState({
        runProblems: { ...s.runProblems, diagnostics: mergeRun(prevRun, next) },
      });
  }
});
