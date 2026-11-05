import { KokoStateRegistry, World, type WorldSnapshot } from "@tukurium/eks";
import type { MaterialDef, PackageResolution, ProjectSnapshot } from "@tukurium/repo-model";
import {
  type BagItem,
  type CapabilityId,
  type EffectEvent,
  type InputEvent,
  Simulation,
  type SoundEvent,
  type SystemStatus,
} from "@tukurium/runtime";
import type { HostPart, SessionFrame } from "@tukurium/shared";
import { create } from "zustand";
import { useApp } from "../app/store";

/**
 * セッションの世界（配置された実体の実行状態）。
 * - 持ち主（セッションのホスト）の画面で Simulation を実行し、状態を配る。
 * - ほかの人は、届いた状態を表示する。入力はホストへ送る。
 * 編集中の制作データ（ワークスペース）とは別で、「適用」したときだけ更新される（要件 §7）。
 */
interface SessionWorldState {
  isHost: boolean;
  sim: Simulation | null;
  remote: {
    world: World;
    names: Record<string, string>;
    materials: MaterialDef[];
    /** プレイヤー → バッグ（ADR 0018） */
    bags: Record<string, BagItem[]>;
  } | null;
  status: SystemStatus[];
  /** ホストから届いた、まだ鳴らしていない音（ホスト以外） */
  incomingSounds: SoundEvent[];
  /** ホストから届いた、まだ出していない一時的な effect（ホスト以外） */
  incomingEffects: EffectEvent[];
  input(ev: InputEvent): void;
  /** 表示する World とマテリアル */
  view(): { world: World; materials: MaterialDef[] } | null;
}

const client = () => useApp.getState().client;

export const useSessionWorld = create<SessionWorldState>((_set, get) => ({
  isHost: false,
  sim: null,
  remote: null,
  status: [],
  incomingSounds: [],
  incomingEffects: [],
  input: (ev) => {
    const named = withPlayerName(ev);
    const { isHost, sim } = get();
    if (isHost && sim) sim.input(named);
    else client().send({ t: "session.input", input: named });
  },
  view: () => {
    const { sim, remote } = get();
    if (sim) return { world: sim.world, materials: sim.materials() };
    if (remote) return { world: remote.world, materials: remote.materials };
    return null;
  },
}));

/** 入力に、今の表示名を添える（すでに名前があればそのまま） */
function withPlayerName(ev: InputEvent): InputEvent {
  if (ev.playerName) return ev;
  const { me, myName } = useApp.getState();
  const playerName = me?.name || myName;
  return playerName ? { ...ev, playerName } : ev;
}

const set = useSessionWorld.setState;
const st = () => useSessionWorld.getState();
const log = (message: string, level: "log" | "error" = "log") => {
  client().send({ t: "session.log", message, level });
  useApp.setState((s) => ({ sessionLogs: [...s.sessionLogs, { message, level }].slice(-50) }));
};

let pending: Promise<void> = Promise.resolve();
/** ホストの操作は届いた順に、Simulation の準備を待ってから行う */
const queue = (fn: () => void | Promise<void>) => {
  pending = pending.then(fn).catch((e) => log(`セッションの世界でエラー：${e}`, "error"));
};

function addPart(sim: Simulation, part: HostPart): void {
  try {
    sim.addPart({
      id: part.id,
      realm: part.realm,
      outputId: part.outputId,
      snapshot: part.snapshot as ProjectSnapshot,
      // 依存の中身（サーバーが持ち主の許可で取り出したもの。ADR 0015）
      ...(part.packages ? { packages: part.packages as PackageResolution[] } : {}),
      position: part.position,
      yaw: part.yaw,
      // 置いた物への付与（null は宣言どおり。ADR 0012）
      ...(part.grants ? { grants: part.grants as CapabilityId[] } : {}),
    });
  } catch (e) {
    log(`配置を読み込めませんでした：${e instanceof Error ? e.message : e}`, "error");
  }
}

client().on((msg) => {
  switch (msg.t) {
    case "session.host":
      queue(async () => {
        st().sim?.dispose();
        const sim = await Simulation.createSession({
          onLog: (entry) => log(entry.message, entry.level),
        });
        for (const part of msg.parts) addPart(sim, part);
        if (msg.resume?.world) {
          sim.restore(
            msg.resume.world as WorldSnapshot,
            msg.resume.names,
            msg.resume.time,
            msg.resume.partEntities,
          );
          // バッグも引き継ぐ（ADR 0018）
          sim.restoreBags(msg.resume.bags as Record<string, BagItem[]> | undefined);
        }
        set({ isHost: true, sim, remote: null, status: sim.systemStatus() });
      });
      return;
    case "host.addPart":
      queue(() => {
        const sim = st().sim;
        if (sim) addPart(sim, msg.part);
      });
      return;
    case "host.apply":
      queue(() => {
        const sim = st().sim;
        if (!sim) return;
        const snap = msg.snapshot as ProjectSnapshot;
        const report = sim.applyPart(
          msg.realm,
          msg.outputId,
          snap,
          msg.packages as PackageResolution[] | undefined,
        );
        const name = snap.outputs.find((o) => o.id === msg.outputId)?.name ?? msg.outputId;
        log(
          `${msg.by} が「${name}」を適用しました（${report.instances} 個を更新、引き継ぎ ${report.kept} / 初期値に戻した ${report.dropped}）`,
        );
      });
      return;
    case "host.removePart":
      queue(() => st().sim?.removePart(msg.id));
      return;
    case "host.setGrants":
      queue(() => {
        st().sim?.setGrants(msg.id, msg.grants as CapabilityId[] | null);
      });
      return;
    case "host.resetPart":
      queue(() => {
        st().sim?.resetPart(msg.id);
        log("配置をリセットしました");
      });
      return;
    case "host.input":
      st().sim?.input(msg.input);
      return;
    case "session.frame":
      if (!st().isHost) applyFrame(msg.frame);
      return;
    case "session.log":
      useApp.setState((s) => ({
        sessionLogs: [...s.sessionLogs, { message: msg.message, level: msg.level }].slice(-50),
      }));
      return;
    case "session.closed":
      resetSessionWorld();
      return;
  }
});

client().onWelcome(() => resetSessionWorld());

/** セッションを出たとき・接続し直したとき */
export function resetSessionWorld(): void {
  queue(() => {
    st().sim?.dispose();
    set({ isHost: false, sim: null, remote: null, status: [] });
  });
}

function applyFrame(frame: SessionFrame): void {
  const world = st().remote?.world ?? new World(new KokoStateRegistry());
  world.restore(frame.world as WorldSnapshot);
  set({
    remote: {
      world,
      names: frame.names,
      materials: frame.materials as MaterialDef[],
      bags: (frame.bags ?? {}) as Record<string, BagItem[]>,
    },
    // 届いた音と effect を、ホスト以外が手元で鳴らす・出す
    incomingSounds: [...st().incomingSounds, ...(frame.sounds ?? [])].slice(-32),
    incomingEffects: [...st().incomingEffects, ...(frame.effects ?? [])].slice(-32),
    status: frame.status,
  });
}

let outgoingSounds: SoundEvent[] = [];
export function queueSessionSounds(sounds: SoundEvent[]): void {
  outgoingSounds = [...outgoingSounds, ...sounds].slice(-32);
}

let outgoingEffects: EffectEvent[] = [];
export function queueSessionEffects(effects: EffectEvent[]): void {
  outgoingEffects = [...outgoingEffects, ...effects].slice(-32);
}

/** ホストが世界の状態を配る（SessionWorldController が間隔を見て呼ぶ） */
export function sendSessionFrame(): void {
  const sim = st().sim;
  if (!st().isHost || !sim) return;
  const sounds = outgoingSounds;
  outgoingSounds = [];
  const effects = outgoingEffects;
  outgoingEffects = [];
  client().send({
    t: "session.frame",
    frame: {
      sounds,
      effects,
      time: sim.time,
      world: sim.world.snapshot(),
      names: Object.fromEntries(sim.world.entityIds().map((id) => [id, sim.nameOf(id)])),
      materials: sim.materials(),
      status: sim.systemStatus(),
      bags: sim.bagsSnapshot(),
      partEntities: sim.partEntitiesSnapshot(),
    },
  });
}

// 開発時のみ：E2E テストやデバッグからストアを参照できるようにする
if (import.meta.env.DEV)
  (window as { __sessionWorld?: typeof useSessionWorld }).__sessionWorld = useSessionWorld;
