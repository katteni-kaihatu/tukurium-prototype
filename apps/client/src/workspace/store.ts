import { gunAndTargetSample, ProjectDoc, type ProjectSnapshot } from "@tukurium/repo-model";
import { type LogEntry, Simulation, type SystemStatus } from "@tukurium/runtime";
import * as Y from "yjs";
import { create } from "zustand";

export type Selection =
  | { kind: "entity"; id: string }
  | { kind: "output"; id: string }
  | { kind: "koko"; id: string }
  | { kind: "system"; id: string }
  | { kind: "material"; id: string };

export type Mode = "edit" | "play" | "paused";

interface WorkspaceState {
  project: ProjectDoc;
  /** 制作データが変わるたびに増える（React の再描画用） */
  rev: number;
  outputId: string;
  selection: Selection | null;
  mode: Mode;
  sim: Simulation | null;
  /** Play 中の実行状態が変わるたびに増える（Inspector の再描画用、間引いて更新） */
  simRev: number;
  systemStatus: SystemStatus[];
  logs: LogEntry[];
  /** コードエディタで開いている System */
  openSystems: string[];
  activeSystem: string | null;
  panelsHidden: boolean;

  select(sel: Selection | null): void;
  setOutput(id: string): void;
  play(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  openSystem(id: string): void;
  closeSystem(id: string): void;
  loadSnapshot(snap: ProjectSnapshot): void;
  togglePanels(): void;
  clearLogs(): void;
}

const STORAGE_KEY = "tukurium.workspace.v1";
const MAX_LOGS = 200;

function loadProject(): ProjectDoc {
  const project = new ProjectDoc();
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      Y.applyUpdate(project.doc, Uint8Array.from(atob(saved), (c) => c.charCodeAt(0)));
      if (project.outputs().length > 0) return project;
    }
  } catch {
    // 壊れていたらサンプルから始める
  }
  project.load(gunAndTargetSample());
  return project;
}

function saveProject(project: ProjectDoc): void {
  try {
    const update = Y.encodeStateAsUpdate(project.doc);
    let bin = "";
    for (let i = 0; i < update.length; i += 0x8000) {
      bin += String.fromCharCode(...update.subarray(i, i + 0x8000));
    }
    localStorage.setItem(STORAGE_KEY, btoa(bin));
  } catch {
    // 保存できなくても作業は続けられる（M2 からはサーバーに保存する）
  }
}

const initialProject = loadProject();

export const useWorkspace = create<WorkspaceState>((set, get) => {
  // 制作データの変更を購読：再描画と保存（間引き）
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  initialProject.observe(() => {
    set((s) => ({ rev: s.rev + 1 }));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveProject(get().project), 400);
  });

  const pushLog = (entry: LogEntry) =>
    set((s) => ({ logs: [...s.logs, entry].slice(-MAX_LOGS) }));

  return {
    project: initialProject,
    rev: 0,
    outputId: initialProject.outputs()[0]?.id ?? "",
    selection: null,
    mode: "edit",
    sim: null,
    simRev: 0,
    systemStatus: [],
    logs: [],
    openSystems: [],
    activeSystem: null,
    panelsHidden: false,

    select: (selection) => set({ selection }),

    setOutput: (outputId) => {
      if (get().mode !== "edit") get().stop();
      set({ outputId, selection: { kind: "output", id: outputId } });
    },

    play: async () => {
      const { project, outputId, mode } = get();
      if (mode !== "edit") return;
      const sim = await Simulation.create(project.snapshot(), outputId, {
        realm: "local",
        onLog: pushLog,
      });
      if (get().mode !== "edit") {
        sim.dispose();
        return;
      }
      pushLog({ time: 0, systemId: null, message: "Play を開始しました", level: "log" });
      set({ sim, mode: "play", systemStatus: sim.systemStatus() });
    },

    pause: () => {
      if (get().mode === "play") set({ mode: "paused" });
    },

    resume: () => {
      if (get().mode === "paused") set({ mode: "play" });
    },

    stop: () => {
      get().sim?.dispose();
      set({ sim: null, mode: "edit", systemStatus: [] });
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

    loadSnapshot: (snap) => {
      get().stop();
      get().project.load(snap);
      set({
        outputId: snap.outputs[0]?.id ?? "",
        selection: null,
        openSystems: [],
        activeSystem: null,
      });
    },

    togglePanels: () => set((s) => ({ panelsHidden: !s.panelsHidden })),
    clearLogs: () => set({ logs: [] }),
  };
});

// 開発時のみ：E2E テストやデバッグからストアを参照できるようにする
if (import.meta.env.DEV) (window as { __workspace?: typeof useWorkspace }).__workspace = useWorkspace;
