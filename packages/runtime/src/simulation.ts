import type {
  EntityId,
  FieldDef,
  FieldValue,
  KokoStateId,
  KokoStateRegistry,
  Vec3,
} from "@tukurium/eks";
import { World, type WorldSnapshot } from "@tukurium/eks";
import {
  type AssetDef,
  BUILTIN,
  buildRegistry,
  compileSystem,
  isBuiltin,
  type MaterialDef,
  type OutputExposure,
  type ProjectSnapshot,
  ResourcePathIndex,
} from "@tukurium/repo-model";
import {
  type HostCallContext,
  type Json,
  type ScriptEntity,
  ScriptError,
  ScriptSandbox,
} from "@tukurium/script";
import { buildWorld } from "./buildWorld";
import { isContractName, parseContractPayload } from "./contracts";
import { type HostArgs, parseHostArgs } from "./hostApi";
import { type CollisionEvent, initPhysics, Physics } from "./physics";
import {
  moveAlongView,
  placeFromView,
  poseInView as poseRelativeToView,
  straightenRotation,
  twistRotation,
  worldTransform,
} from "./transform";

/** 入力の動作。利用者のスクリプトは action 名で受け取る。 */
/** 右クリックで物を持てる距離（m） */
const GRAB_REACH = 6;

export interface InputEvent {
  action: string;
  phase: "down" | "up";
  /** 入力した人の視点（レイの始点と向き） */
  origin: Vec3;
  direction: Vec3;
  player: string;
  /**
   * 追加の数値。
   * twist ではマウスの移動（ラジアン、[ヨー, ピッチ]）。
   * reach では前後の移動（メートル、[距離, 0]。正で奥へ）。
   */
  pointer?: [number, number];
}

export interface SystemStatus {
  id: string;
  name: string;
  enabled: boolean;
  /** 読み込みや実行で止まった理由 */
  error: string | null;
  /** 止まった場所（スクリプトの行。分かるときだけ） */
  line: number | null;
}

export interface LogEntry {
  time: number;
  systemId: string | null;
  message: string;
  level: "log" | "error";
}

export interface SimulationOptions {
  /** スクリプトの領域（リポジトリ単位）。別リポジトリの System とは別の VM になる。 */
  realm: string;
  onLog?: (entry: LogEntry) => void;
  timeLimitMs?: number;
}

/** セッションに配置された実体（アウトプットの 1 回分の配置） */
export interface PartSpec {
  id: string;
  /** リポジトリ（ワークスペース）。KokoState の名前とスクリプトの領域はこの単位で分かれる */
  realm: string;
  outputId: string;
  snapshot: ProjectSnapshot;
  /** 配置の位置と向き（ルートの Entity に足す） */
  position: Vec3;
  yaw: number;
}

/** 一時的な effect（ホストが手元で出し、状態と一緒にほかの人にも配る。保存しない） */
export interface EffectEvent {
  kind: EffectKind;
  position: Vec3;
  color: string;
  /** 大きさ（m） */
  size: number;
  /** 寿命（秒） */
  life: number;
}

export const EFFECT_KINDS = ["spark"] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];
const MAX_EFFECTS = 32;

/** 鳴らす音（ホストが手元で鳴らし、状態と一緒にほかの人にも配る） */
export interface SoundEvent {
  /** 音声の素材 ID */
  asset: string;
  /** 鳴らす位置（なければ聞いている人の位置） */
  position: Vec3 | null;
  volume: number;
}

export interface ApplyReport {
  /** 更新した配置の数 */
  instances: number;
  /** 実行値を引き継いだフィールドの数 */
  kept: number;
  /** マークはあったが、互換性がないなどで初期値に戻したフィールドの数 */
  dropped: number;
}

interface Part extends PartSpec {
  entities: Set<EntityId>;
}

interface LoadedSystem {
  /** サンドボックス上の ID（セッションでは「領域:System ID」） */
  id: string;
  realm: string;
  /** この System を使っている配置 */
  users: Set<string>;
  name: string;
  with: KokoStateId[];
  without: KokoStateId[];
  handlers: Set<string>;
  enabled: boolean;
  error: string | null;
  line: number | null;
}

interface PendingEvent {
  /** event：同じ配置の中のイベント（onEvent）、contract：公開 Contract（contracts.名前） */
  kind: "event" | "contract";
  target: EntityId;
  name: string;
  data: Json;
}

/** Raycast の結果の opaque handle（ADR 0012）。token は推測しにくい文字列で、表を引く鍵 */
interface HitHandle {
  target: EntityId;
  /** 当たった点（effect を出す場所） */
  point: Vec3;
  /** Contract を送ったか・effect を出したか（それぞれ一度だけ） */
  contractUsed: boolean;
  effectUsed: boolean;
  /** 発行したときの呼び出しの主体の配置 */
  parts: Set<string>;
  /** この時刻を過ぎたら使えない */
  expires: number;
}

/** handle の寿命（秒） */
const HANDLE_TTL = 1;

const MAX_EVENTS_PER_STEP = 256;

/** スクリプトから呼べる API（名前空間.関数名）。 */
export const HOST_API = [
  "world.raycast",
  "world.emit",
  "world.get",
  "world.set",
  "world.find",
  "world.spawn",
  "world.destroy",
  "time.now",
  "audio.play",
  "contract.send",
  "effects.spawn",
] as const;
export type HostName = (typeof HOST_API)[number];

/**
 * アウトプットを実行する。EKS の World ＋ 物理 ＋ スクリプト。
 *
 * - ワークスペースの再生では、1 つのアウトプットをそのまま（ID を付け替えずに）実行する（create）。
 * - セッションでは、複数のリポジトリのアウトプットを「配置」として同じ世界に置く（createSession / addPart）。
 *   Entity の ID は配置ごと（「配置ID/EntityID」）、KokoState とマテリアルの ID はリポジトリごと
 *   （「領域:ID」）に付け替え、KokoState の名前はリポジトリごとのスコープで引く。物理とイベントは共通なので、
 *   別のリポジトリの銃で別のリポジトリの的を撃てる。
 *
 * 1 ステップの順序：
 *   1. 物理ワールドへ反映（追加・削除・動かない剛体の移動）して計算 → 衝突イベント → onCollision
 *   2. 入力イベント → 各 System の onInput
 *   3. 各 System の onUpdate（アウトプットの並び順）
 *   4. world.emit で送られたイベント → onEvent（空になるまで、上限あり）
 *
 * Rapier の検索構造（レイキャスト用）は物理の計算時にしか更新されないため、物理を先に進める。
 * スクリプトが動かした物体の当たり判定は、次のステップから反映される。
 */
export class Simulation {
  readonly world: World;
  readonly registry: KokoStateRegistry;
  time = 0;
  private readonly systems: LoadedSystem[] = [];
  private readonly names = new Map<EntityId, string>();
  private readonly parts = new Map<string, Part>();
  private readonly realmDefs = new Map<string, Set<KokoStateId>>();
  private readonly realmMaterials = new Map<string, MaterialDef[]>();
  private readonly realmAssets = new Map<string, AssetDef[]>();
  private sounds: SoundEvent[] = [];
  private effects: EffectEvent[] = [];
  private inputs: InputEvent[] = [];
  private pending: PendingEvent[] = [];
  private readonly handles = new Map<string, HitHandle>();
  private disposed = false;

  private constructor(
    private readonly sandbox: ScriptSandbox,
    private physics: Physics,
    /** true：セッション（ID を付け替える）、false：ワークスペースの再生（そのまま） */
    private readonly multi: boolean,
    private readonly options: { onLog?: (entry: LogEntry) => void },
  ) {
    this.registry = buildRegistry([]);
    this.world = new World(this.registry);
  }

  private static async make(multi: boolean, options: Omit<SimulationOptions, "realm">) {
    await initPhysics();
    const ref: { sim: Simulation | null } = { sim: null };
    const sandbox = await ScriptSandbox.create({
      timeLimitMs: options.timeLimitMs ?? 20,
      hostFunctions: Object.fromEntries(
        HOST_API.map((name) => [
          name,
          (args: Json[], ctx: HostCallContext) => ref.sim?.callHost(name, args, ctx),
        ]),
      ),
      onLog: (message, ctx) => ref.sim?.log(ctx.systemId, message, "log"),
    });
    const sim = new Simulation(sandbox, new Physics(), multi, options);
    ref.sim = sim;
    return sim;
  }

  /** ワークスペースの再生：1 つのアウトプットを、ID を付け替えずに実行する */
  static async create(
    snapshot: ProjectSnapshot,
    outputId: string,
    options: SimulationOptions,
  ): Promise<Simulation> {
    const sim = await Simulation.make(false, options);
    if (!snapshot.outputs.some((o) => o.id === outputId)) {
      sim.dispose();
      throw new Error(`Unknown output: ${outputId}`);
    }
    sim.addPart({
      id: "main",
      realm: options.realm,
      outputId,
      snapshot,
      position: [0, 0, 0],
      yaw: 0,
    });
    return sim;
  }

  /** セッションの世界：配置は addPart で足していく */
  static async createSession(options: Omit<SimulationOptions, "realm"> = {}): Promise<Simulation> {
    return Simulation.make(true, options);
  }

  /** 配置を足す（同じ ID があれば置き換える） */
  addPart(spec: PartSpec): void {
    // 配置や版が変わったら、発行済みの handle は使えなくする（ADR 0012 §6）
    this.handles.clear();
    if (this.parts.has(spec.id)) this.removePart(spec.id);
    const part: Part = { ...spec, entities: new Set() };
    this.parts.set(part.id, part);
    this.registerRealm(part.realm, part.snapshot);
    this.instantiate(part);
    this.loadSystems(part);
  }

  removePart(id: string): void {
    // 配置や版が変わったら、発行済みの handle は使えなくする（ADR 0012 §6）
    this.handles.clear();
    const part = this.parts.get(id);
    if (!part) return;
    this.clearEntities(part);
    this.parts.delete(id);
    for (const sys of [...this.systems]) {
      sys.users.delete(id);
      if (sys.users.size === 0) this.dropSystem(sys);
    }
    if (![...this.parts.values()].some((p) => p.realm === part.realm)) {
      for (const k of this.realmDefs.get(part.realm) ?? []) this.registry.unregister(k);
      this.realmDefs.delete(part.realm);
      this.realmMaterials.delete(part.realm);
      this.realmAssets.delete(part.realm);
    }
  }

  partList(): { id: string; realm: string; outputId: string; position: Vec3; yaw: number }[] {
    return [...this.parts.values()].map((p) => ({
      id: p.id,
      realm: p.realm,
      outputId: p.outputId,
      position: p.position,
      yaw: p.yaw,
    }));
  }

  /**
   * 適用：同じリポジトリ・アウトプットの配置を、新しい制作データで作り直す（要件 §7）。
   * 状態維持のマークがあり、型が変わっていないフィールドだけ、現在の実行値を引き継ぐ。
   * それ以外の値は新しい制作データの値になる。System のコードも読み直す。
   */
  applyPart(realm: string, outputId: string, snapshot: ProjectSnapshot): ApplyReport {
    // 配置や版が変わったら、発行済みの handle は使えなくする（ADR 0012 §6）
    this.handles.clear();
    const targets = [...this.parts.values()].filter(
      (p) => p.realm === realm && p.outputId === outputId,
    );
    const report: ApplyReport = { instances: targets.length, kept: 0, dropped: 0 };
    if (targets.length === 0) return report;
    const marks = snapshot.outputs.find((o) => o.id === outputId)?.keep ?? [];
    const newDefs = new Map(snapshot.kokostates.map((d) => [d.id, d]));

    // 1. マークされたフィールドの現在値を集める（古い定義と新しい定義で型が同じものだけ）
    const kept = new Map<
      string,
      { entity: EntityId; koko: KokoStateId; field: string; value: FieldValue }[]
    >();
    for (const part of targets) {
      const list: { entity: EntityId; koko: KokoStateId; field: string; value: FieldValue }[] = [];
      for (const m of marks) {
        const entity = this.eid(part, m.entity);
        const koko = this.kid(realm, m.koko);
        const oldField = this.registry.get(koko)?.fields.find((f) => f.id === m.field);
        const newDef = isBuiltin(m.koko) ? this.registry.get(koko) : newDefs.get(m.koko);
        const newField = newDef?.fields.find((f) => f.id === m.field);
        const current = this.world.get(entity, koko)?.[m.field];
        if (oldField && newField && oldField.type === newField.type && current !== undefined) {
          list.push({ entity, koko, field: m.field, value: structuredClone(current) });
          report.kept++;
        } else {
          report.dropped++;
        }
      }
      kept.set(part.id, list);
    }

    // 2. 定義・マテリアルを入れ替えて、配置を作り直す
    for (const part of targets) {
      this.clearEntities(part);
      part.snapshot = snapshot;
    }
    this.registerRealm(realm, snapshot);
    for (const part of targets) {
      this.instantiate(part);
      for (const k of kept.get(part.id) ?? []) {
        const values = this.world.get(k.entity, k.koko);
        if (values && k.field in values) values[k.field] = k.value;
      }
    }

    // 3. System を読み直す
    const ids = new Set(targets.map((p) => p.id));
    for (const sys of [...this.systems]) {
      if (sys.realm !== realm) continue;
      for (const id of ids) sys.users.delete(id);
      if (sys.users.size === 0) this.dropSystem(sys);
    }
    for (const part of targets) this.loadSystems(part, true);
    return report;
  }

  /** リセット：配置を、いまの制作データの初期値で作り直す（実行値は引き継がない） */
  resetPart(id: string): void {
    // 配置や版が変わったら、発行済みの handle は使えなくする（ADR 0012 §6）
    this.handles.clear();
    const part = this.parts.get(id);
    if (!part) return;
    this.clearEntities(part);
    this.instantiate(part);
  }

  /** この間に鳴らされた音を取り出す */
  /** 出した一時的な effect を取り出す（描画と配信用） */
  drainEffects(): EffectEvent[] {
    const out = this.effects;
    this.effects = [];
    return out;
  }

  drainSounds(): SoundEvent[] {
    const out = this.sounds;
    this.sounds = [];
    return out;
  }

  /** 表示用のマテリアル一覧（セッションでは ID が付け替え済み） */
  materials(): MaterialDef[] {
    return [...this.realmMaterials.values()].flat();
  }

  /** 実行中の System の状態（Inspector・エラー表示用） */
  systemStatus(): SystemStatus[] {
    return this.systems.map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      error: s.error,
      line: s.line,
    }));
  }

  nameOf(id: EntityId): string {
    return this.names.get(id) ?? id;
  }

  /**
   * 別のホストから引き継いだ状態にする（ADR 0002）。物理ワールドは EKS の値（Transform・速度）から作り直す。
   */
  restore(world: WorldSnapshot, names: Record<string, string>, time: number): void {
    // 配置や版が変わったら、発行済みの handle は使えなくする（ADR 0012 §6）
    this.handles.clear();
    this.world.restore(world);
    this.names.clear();
    for (const [id, n] of Object.entries(names)) this.names.set(id, n);
    this.time = time;
    this.physics.dispose();
    this.physics = new Physics();
  }

  input(ev: InputEvent): void {
    this.inputs.push(ev);
  }

  step(dt: number): void {
    if (this.disposed) return;
    this.time += dt;
    this.physics.sync(this.world);
    const collisions = this.physics.step(this.world, dt);
    for (const c of collisions) this.dispatchCollision(c);

    const inputs = this.inputs;
    this.inputs = [];
    for (const ev of inputs) {
      if (this.builtinInput(ev)) continue;
      for (const sys of this.active("onInput"))
        this.runSystem(sys, "onInput", this.matches(sys), [ev as unknown as Json]);
    }

    for (const sys of this.active("onUpdate"))
      this.runSystem(sys, "onUpdate", this.matches(sys), [dt]);

    let budget = MAX_EVENTS_PER_STEP;
    while (this.pending.length > 0 && budget-- > 0) {
      const ev = this.pending.shift() as PendingEvent;
      if (!this.world.has(ev.target)) continue;
      if (ev.kind === "contract") {
        const handler = `contract:${ev.name}`;
        for (const sys of this.active(handler))
          if (this.entityMatches(sys, ev.target))
            this.runSystem(sys, handler, [ev.target], [ev.data]);
        continue;
      }
      for (const sys of this.active("onEvent")) {
        if (this.entityMatches(sys, ev.target)) {
          this.runSystem(sys, "onEvent", [ev.target], [{ name: ev.name, data: ev.data }]);
        }
      }
    }
    if (this.pending.length > 0) {
      this.log(null, `イベントが多すぎるため ${this.pending.length} 件を捨てました`, "error");
      this.pending = [];
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sandbox.dispose();
    this.physics.dispose();
  }

  // ---------------------------------------------------------------------------

  private kid(realm: string, id: KokoStateId): KokoStateId {
    return this.multi && !isBuiltin(id) ? `${realm}:${id}` : id;
  }

  private eid(part: { id: string }, id: EntityId): EntityId {
    return this.multi ? `${part.id}/${id}` : id;
  }

  private mid(realm: string, id: string): string {
    return this.multi ? `${realm}:${id}` : id;
  }

  private scopeOfRealm(realm: string): string {
    return this.multi ? realm : "";
  }

  /** リポジトリの KokoState 定義とマテリアルを登録し直す */
  private registerRealm(realm: string, snapshot: ProjectSnapshot): void {
    const scope = this.scopeOfRealm(realm);
    const next = new Set<KokoStateId>();
    for (const k of this.realmDefs.get(realm) ?? []) this.registry.unregister(k);
    for (const def of snapshot.kokostates) {
      const id = this.kid(realm, def.id);
      this.registry.register({ ...def, id }, scope);
      next.add(id);
    }
    this.realmDefs.set(realm, next);
    this.realmMaterials.set(
      realm,
      snapshot.materials.map((m) => ({ ...m, id: this.mid(realm, m.id) })),
    );
    this.realmAssets.set(realm, snapshot.assets ?? []);
  }

  /**
   * 組み込みの入力。処理したら true（スクリプトの onInput には渡さない）。
   * - grab：右クリックを押している間、Grabbable を持つ。離すと放す。持った瞬間の位置と角度は変えない
   * - hold：持っている物を、視点との位置関係を保ったまま動かす
   * - align：傾きを直し、上下の軸（Y）の向きだけ残す
   * - twist：マウスの動きで、持っている物の角度を変える
   * - reach：ホイールで、持っている物を前後に動かす
   */
  private builtinInput(ev: InputEvent): boolean {
    if (
      ev.action !== "grab" &&
      ev.action !== "hold" &&
      ev.action !== "align" &&
      ev.action !== "twist" &&
      ev.action !== "reach"
    )
      return false;
    const mine = this.heldBy(ev.player);
    if (ev.action === "hold") {
      for (const id of mine) this.placeHeld(id, ev);
      return true;
    }
    if (ev.action === "align") {
      if (ev.phase === "down") for (const id of mine) this.straightenHeld(id, ev);
      return true;
    }
    if (ev.action === "twist") {
      for (const id of mine) this.twistHeld(id, ev);
      return true;
    }
    if (ev.action === "reach") {
      const delta = ev.pointer?.[0] ?? 0;
      if (delta !== 0) for (const id of mine) this.reachHeld(id, ev, delta);
      return true;
    }
    if (ev.phase === "up") {
      // 放す：見えている位置に置いてから手を放す（動く剛体なら落ちる）
      for (const id of mine) {
        this.placeHeld(id, ev);
        this.world.remove(id, BUILTIN.Held);
        const rb = this.world.get(id, BUILTIN.RigidBody);
        if (rb) rb.linvel = [0, 0, 0];
      }
      return true;
    }
    if (ev.phase !== "down" || mine.length > 0) return true;
    const hit = this.physics.raycast(ev.origin, ev.direction, GRAB_REACH, []);
    // 当たった物か、その親のうち、Grabbable を持ついちばん近いもの（持てるのはいちばん上の Entity だけ）
    let target: EntityId | null = hit?.entity ?? null;
    while (target && !this.world.hasState(target, BUILTIN.Grabbable))
      target = this.world.parentOf(target);
    if (!target || this.world.parentOf(target) !== null) return true;
    if (this.world.hasState(target, BUILTIN.Held)) return true; // ほかの人が持っている
    const pose = this.poseInView(target, ev);
    if (!pose) return true;
    this.world.add(target, BUILTIN.Held, { ...pose, player: ev.player });
    return true;
  }

  private heldBy(player: string): EntityId[] {
    return this.world
      .query({ with: [BUILTIN.Grabbable, BUILTIN.Held] })
      .filter((id) => this.world.get(id, BUILTIN.Held)?.player === player);
  }

  /** いまの位置と角度を、視点からの差として覚える（持った瞬間に動かさないため） */
  private poseInView(id: EntityId, ev: InputEvent): { offset: Vec3; rotation: Vec3 } | null {
    const t = this.world.get(id, BUILTIN.Transform);
    if (!t) return null;
    return poseRelativeToView(ev.origin, ev.direction, t.position as Vec3, t.rotation as Vec3);
  }

  /** 覚えた位置関係のまま、持っている人の視点へ置く（ほかの人にはこの位置で見える） */
  private placeHeld(id: EntityId, ev: InputEvent): void {
    const t = this.world.get(id, BUILTIN.Transform);
    const held = this.world.get(id, BUILTIN.Held);
    if (!t || !held) return;
    const placed = placeFromView(
      ev.origin,
      ev.direction,
      (held.offset as Vec3 | undefined) ?? [0, 0, 0],
      (held.rotation as Vec3 | undefined) ?? [0, 0, 0],
    );
    t.position = placed.position;
    t.rotation = placed.rotation;
  }

  /** 傾きを直し、上下の軸まわりの向きだけ残す */
  private straightenHeld(id: EntityId, ev: InputEvent): void {
    const t = this.world.get(id, BUILTIN.Transform);
    const held = this.world.get(id, BUILTIN.Held);
    if (!t || !held) return;
    t.rotation = straightenRotation(t.rotation as Vec3);
    const pose = this.poseInView(id, ev);
    if (pose) held.rotation = pose.rotation;
  }

  /** ホイールの分だけ、持っている物を前後に動かす（画面上の位置は保つ） */
  private reachHeld(id: EntityId, ev: InputEvent, deltaMeters: number): void {
    const held = this.world.get(id, BUILTIN.Held);
    if (!held) return;
    held.offset = moveAlongView((held.offset as Vec3 | undefined) ?? [0, 0, 0], deltaMeters);
    this.placeHeld(id, ev);
  }

  /** マウスの動き（ラジアン）だけ、持っている物を回す */
  private twistHeld(id: EntityId, ev: InputEvent): void {
    const t = this.world.get(id, BUILTIN.Transform);
    const held = this.world.get(id, BUILTIN.Held);
    const [yaw, pitch] = ev.pointer ?? [0, 0];
    if (!t || !held || (yaw === 0 && pitch === 0)) return;
    t.rotation = twistRotation(t.rotation as Vec3, yaw, pitch);
    const pose = this.poseInView(id, ev);
    if (pose) held.rotation = pose.rotation;
  }

  /** 配置の Entity を World に作る（ID の付け替え、ルートへの配置の位置・向き） */
  private instantiate(part: Part): void {
    const { world, names } = buildWorld(
      part.snapshot,
      part.outputId,
      buildRegistry(part.snapshot.kokostates),
    );
    const snap = world.snapshot();
    const cos = Math.cos(part.yaw);
    const sin = Math.sin(part.yaw);
    const moved = part.yaw !== 0 || part.position.some((v) => v !== 0);
    for (const e of snap.entities) {
      const id = this.eid(part, e.id);
      if (this.world.has(id)) this.world.destroy(id);
      this.world.spawn(id, e.parent === null ? null : this.eid(part, e.parent));
      for (const [koko, values] of Object.entries(e.states)) {
        const k = this.kid(part.realm, koko);
        if (!this.registry.get(k)) continue;
        const v = { ...values };
        if (koko === BUILTIN.Mesh && typeof v.material === "string")
          v.material = this.mid(part.realm, v.material);
        const def = this.registry.require(k);
        for (const f of def.fields) {
          if (f.type === "entity" && typeof v[f.id] === "string")
            v[f.id] = this.eid(part, v[f.id] as string);
        }
        if (koko === BUILTIN.Transform && e.parent === null && moved) {
          const p = v.position as Vec3;
          const r = v.rotation as Vec3;
          v.position = [
            part.position[0] + p[0] * cos + p[2] * sin,
            part.position[1] + p[1],
            part.position[2] - p[0] * sin + p[2] * cos,
          ];
          v.rotation = [r[0], r[1] + (part.yaw * 180) / Math.PI, r[2]];
        }
        this.world.add(id, k, v);
      }
      this.names.set(id, names.get(e.id) ?? e.id);
      part.entities.add(id);
    }
  }

  private clearEntities(part: Part): void {
    for (const id of part.entities) {
      this.world.destroy(id);
      this.physics.remove(id);
      this.names.delete(id);
    }
    part.entities.clear();
  }

  private dropSystem(sys: LoadedSystem): void {
    this.sandbox.unloadSystem(sys.id);
    this.systems.splice(this.systems.indexOf(sys), 1);
  }

  private loadSystems(part: Part, reload = false): void {
    const output = part.snapshot.outputs.find((o) => o.id === part.outputId);
    if (!output) throw new Error(`Unknown output: ${part.outputId}`);
    let index: ResourcePathIndex | null = null;
    for (const ref of output.systems) {
      const def = part.snapshot.systems.find((s) => s.id === ref.id);
      if (!def) continue;
      const id = this.multi ? `${part.realm}:${def.id}` : def.id;
      const existing = this.systems.find((s) => s.id === id);
      if (existing && !reload) {
        existing.users.add(part.id);
        continue;
      }
      if (existing) this.dropSystem(existing);
      const sys: LoadedSystem = {
        id,
        realm: part.realm,
        users: new Set([part.id]),
        name: def.name,
        with: [],
        without: [],
        handlers: new Set(),
        enabled: ref.enabled,
        error: null,
        line: null,
      };
      this.systems.push(sys);
      if (!ref.enabled) continue;
      try {
        // import した KokoState を安定 ID に結び付けた JS にしてから読み込む（ADR 0010）
        index ??= ResourcePathIndex.fromSnapshot(part.snapshot);
        const compiled = compileSystem(def.id, def.code, index);
        const first = compiled.diagnostics[0];
        if (!compiled.ok && first)
          throw new ScriptError(
            first.message,
            id,
            "load",
            first.location?.kind === "script" ? first.location.line : null,
          );
        const meta = this.sandbox.loadSystem(id, compiled.javascript, part.realm);
        const scope = this.scopeOfRealm(part.realm);
        const resolve = (names: string[]) =>
          names.map((n) => {
            const k = this.registry.idOf(n, scope);
            if (!k) throw new ScriptError(`Query の KokoState「${n}」が見つかりません`, id, "load");
            return k;
          });
        sys.with = resolve(meta.query.with);
        sys.without = resolve(meta.query.without);
        sys.handlers = new Set(meta.handlers);
      } catch (e) {
        this.fail(sys, e);
      }
    }
  }

  /**
   * 呼び出しの主体の配置（ADR 0012）。処理中の Entity が分かればその配置、
   * 分からなければ（ハンドラの外）その System を使っている配置すべて。
   */
  private callerParts(ctx: HostCallContext): Part[] {
    const entity = ctx.entity ?? null;
    if (entity) {
      const part = [...this.parts.values()].find((p) => p.entities.has(entity));
      if (part) return [part];
    }
    const sys = this.systems.find((x) => x.id === ctx.systemId);
    return sys ? [...sys.users].flatMap((id) => this.parts.get(id) ?? []) : [];
  }

  /** Entity が入っている配置 */
  private partOf(id: EntityId): Part | undefined {
    return [...this.parts.values()].find((p) => p.entities.has(id));
  }

  /** 別の配置からの見え方（ADR 0012。ないときは interactive） */
  private exposureOf(part: Part): OutputExposure {
    return part.snapshot.outputs.find((o) => o.id === part.outputId)?.exposure ?? "interactive";
  }

  /** opaque handle を発行する（推測しにくい token） */
  private issueHandle(target: EntityId, point: Vec3, callers: Part[]): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const token = `tk_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    // 古い handle がたまりすぎないよう、期限切れを捨てる
    if (this.handles.size > 1024)
      for (const [k, h] of this.handles) if (h.expires < this.time) this.handles.delete(k);
    this.handles.set(token, {
      target,
      point,
      contractUsed: false,
      effectUsed: false,
      parts: new Set(callers.map((p) => p.id)),
      expires: this.time + HANDLE_TTL,
    });
    return token;
  }

  /**
   * スクリプトから呼ばれた Host API。引数は HOST_API_ARGS で検証し、対象は
   * 呼んだ System の配置の中だけに絞る（別の配置は「見つからない」。ADR 0012）。
   * 別の配置へは、Raycast の opaque handle と公開 Contract（contract.send）だけで届く（U2）。
   */
  private callHost(name: HostName, rawArgs: Json[], ctx: HostCallContext): Json | undefined {
    const scope = this.scopeOfRealm(ctx.realm);
    const callers = this.callerParts(ctx);
    const own = (id: string | undefined): id is EntityId =>
      typeof id === "string" && this.world.has(id) && callers.some((p) => p.entities.has(id));
    const api: { [N in HostName]: (args: HostArgs<N>) => Json | undefined } = {
      "world.raycast": ([origin, direction, max, opts]) => {
        // 非公開（private）の別の配置には当たらない（見つからない）
        const hidden = [...this.parts.values()]
          .filter((p) => !callers.includes(p) && this.exposureOf(p) === "private")
          .flatMap((p) => [...p.entities]);
        const hit = this.physics.raycast(origin, direction, max ?? 100, [
          ...(opts?.exclude ?? []),
          ...hidden,
        ]);
        if (!hit) return null;
        const token = this.issueHandle(hit.entity, hit.point, callers);
        // 自分の配置の Entity のときだけ、生の ID を渡す
        return {
          token,
          entity: own(hit.entity) ? hit.entity : null,
          distance: hit.distance,
          point: hit.point,
        };
      },
      "world.emit": ([target, name, data]) => {
        // イベントは同じ配置の中だけ。別の配置へは公開 Contract（hit.send）で送る
        if (own(target))
          this.pending.push({ kind: "event", target, name, data: (data ?? null) as Json });
        return undefined;
      },
      "contract.send": ([token, name, payload]) => {
        if (!isContractName(name)) throw new TypeError(`Contract「${name}」はありません`);
        const data = parseContractPayload(name, payload) as Json;
        const handle = this.handles.get(token);
        // 偽の・期限切れの・別の配置で発行された handle は「無いもの」と同じ
        if (!handle) return false;
        if (handle.expires < this.time) {
          this.handles.delete(token);
          return false;
        }
        if (!callers.some((p) => handle.parts.has(p.id)) || handle.contractUsed) return false;
        handle.contractUsed = true;
        const target = handle.target;
        if (!this.world.has(target)) return false;
        const targetPart = this.partOf(target);
        if (!own(target) && (!targetPart || this.exposureOf(targetPart) !== "interactive")) {
          this.log(
            ctx.systemId,
            `${name} は受け付けられませんでした（相手が受け付けていません）`,
            "log",
          );
          return false;
        }
        const handler = `contract:${name}`;
        if (!this.active(handler).some((sys) => this.entityMatches(sys, target))) return false;
        this.pending.push({ kind: "contract", target, name, data });
        return true;
      },
      "effects.spawn": ([token, kind, opts]) => {
        if (!(EFFECT_KINDS as readonly string[]).includes(kind))
          throw new TypeError(
            `effect「${kind}」はありません（使えるもの：${EFFECT_KINDS.join("・")}）`,
          );
        const handle = this.handles.get(token);
        if (!handle || handle.expires < this.time) return false;
        if (!callers.some((p) => handle.parts.has(p.id)) || handle.effectUsed) return false;
        if (this.effects.length >= MAX_EFFECTS) return false;
        handle.effectUsed = true;
        const clamp = (v: number | undefined, lo: number, hi: number, d: number) =>
          v === undefined ? d : Math.min(hi, Math.max(lo, v));
        this.effects.push({
          kind: kind as EffectKind,
          position: handle.point,
          color: opts?.color && /^#[0-9a-fA-F]{6}$/.test(opts.color) ? opts.color : "#ffffff",
          size: clamp(opts?.size, 0.01, 1, 0.15),
          life: clamp(opts?.life, 0.05, 2, 0.4),
        });
        return true;
      },
      "world.get": ([id, kokoName]) => {
        const koko = kokoName ? this.registry.idOf(kokoName, scope) : undefined;
        if (!koko || !own(id) || !this.world.hasState(id, koko)) return null;
        return this.toNamed(koko, this.world.get(id, koko) ?? {});
      },
      "world.set": ([id, kokoName, values]) => {
        const koko = kokoName ? this.registry.idOf(kokoName, scope) : undefined;
        if (!koko || !own(id) || !this.world.hasState(id, koko) || !values) return false;
        this.writeNamed(id, koko, values as Record<string, Json>, null);
        return true;
      },
      "world.find": ([name]) => {
        for (const [id, n] of this.names) if (n === name && own(id)) return id;
        return null;
      },
      "world.spawn": ([desc]) => {
        const parent = own(desc?.parent) ? desc.parent : null;
        const id = this.world.spawn(undefined, parent);
        this.names.set(id, desc?.name ?? id);
        // 作った Entity は、呼んだ System の配置のものにする
        callers[0]?.entities.add(id);
        for (const [kokoName, values] of Object.entries(desc?.states ?? {})) {
          const koko = this.registry.idOf(kokoName, scope);
          if (!koko) continue;
          this.world.add(id, koko);
          if (values && typeof values === "object" && !Array.isArray(values)) {
            this.writeNamed(id, koko, values as Record<string, Json>, null);
          }
        }
        return id;
      },
      "world.destroy": ([id]) => {
        if (own(id)) this.world.destroy(id);
        return undefined;
      },
      "time.now": () => this.time,
      "audio.play": ([clip, entity, volume]) => {
        // clip：素材の名前か ID。null なら entity の AudioSource の clip を鳴らす
        const target = own(entity) ? entity : null;
        const source = target ? this.world.get(target, BUILTIN.AudioSource) : undefined;
        const assets = this.realmAssets.get(ctx.realm) ?? [];
        const ref = clip ?? (source?.clip as string | null | undefined);
        const asset =
          assets.find((a) => a.kind === "audio" && (a.name === ref || a.id === ref))?.id ??
          (typeof ref === "string" && /^[0-9a-f]{64}$/.test(ref) ? ref : null);
        if (!asset) return false;
        const pos = target ? worldTransform(this.world, target).position : null;
        const vol = volume ?? (typeof source?.volume === "number" ? source.volume : 1);
        if (this.sounds.length < 32) {
          this.sounds.push({ asset, position: pos ? [pos.x, pos.y, pos.z] : null, volume: vol });
        }
        return true;
      },
    };
    const call = api[name] as (args: unknown) => Json | undefined;
    return call(parseHostArgs(name, rawArgs));
  }

  private active(handler: string): LoadedSystem[] {
    return this.systems.filter((s) => s.enabled && s.handlers.has(handler));
  }

  private matches(sys: LoadedSystem): EntityId[] {
    return this.world.query({ with: sys.with, without: sys.without });
  }

  private entityMatches(sys: LoadedSystem, id: EntityId): boolean {
    return (
      sys.with.every((k) => this.world.hasState(id, k)) &&
      !sys.without.some((k) => this.world.hasState(id, k))
    );
  }

  private dispatchCollision(c: CollisionEvent): void {
    for (const [self, other] of [
      [c.a, c.b],
      [c.b, c.a],
    ] as const) {
      if (!this.world.has(self)) continue;
      for (const sys of this.active("onCollision")) {
        if (this.entityMatches(sys, self)) {
          this.runSystem(sys, "onCollision", [self], [{ other, started: c.started }]);
        }
      }
    }
  }

  private runSystem(sys: LoadedSystem, handler: string, ids: EntityId[], args: Json[]): void {
    if (ids.length === 0 || !sys.enabled) return;
    const before = ids.map((id) => this.toScriptEntity(id));
    try {
      const after = this.sandbox.run(sys.id, handler, before, args);
      after.forEach((e, i) => {
        const prev = before[i];
        if (!prev || e.id !== prev.id || !this.world.has(e.id)) return;
        for (const [kokoName, values] of Object.entries(e.states)) {
          // 名前は、その Entity が持っている KokoState の中から引く（別リポジトリの Entity でも正しく書ける）
          const koko = this.world
            .statesOf(e.id)
            .find((k) => this.registry.get(k)?.name === kokoName);
          if (!koko || !values || typeof values !== "object") continue;
          this.writeNamed(
            e.id,
            koko,
            values as Record<string, Json>,
            prev.states[kokoName] ?? null,
          );
        }
      });
    } catch (e) {
      this.fail(sys, e);
      if (this.sandbox.broken) this.dispose();
    }
  }

  private toScriptEntity(id: EntityId): ScriptEntity {
    const states: ScriptEntity["states"] = {};
    for (const koko of this.world.statesOf(id)) {
      const def = this.registry.get(koko);
      if (def) states[def.name] = this.toNamed(koko, this.world.get(id, koko) ?? {});
    }
    return { id, states };
  }

  private toNamed(koko: KokoStateId, values: Record<string, FieldValue>): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const f of this.registry.require(koko).fields)
      out[f.name] = cloneJson(values[f.id] as Json);
    return out;
  }

  /** スクリプトが書いた値（フィールド名）を World（フィールド ID）へ書く。変わったフィールドだけ・型が合うものだけ。 */
  private writeNamed(
    id: EntityId,
    koko: KokoStateId,
    values: Record<string, Json>,
    before: Record<string, Json> | null,
  ): void {
    const target = this.world.get(id, koko);
    if (!target) return;
    for (const f of this.registry.require(koko).fields) {
      if (!(f.name in values)) continue;
      const v = values[f.name] as Json;
      if (before && JSON.stringify(before[f.name]) === JSON.stringify(v)) continue;
      if (accepts(f, v)) target[f.id] = cloneJson(v) as FieldValue;
    }
  }

  private fail(sys: LoadedSystem, e: unknown): void {
    sys.enabled = false;
    sys.error = e instanceof Error ? e.message : String(e);
    sys.line = e instanceof ScriptError ? e.line : null;
    const at = sys.line ? `（${sys.line} 行目）` : "";
    this.log(sys.id, `${sys.name} を停止しました${at}：${sys.error}`, "error");
  }

  private log(systemId: string | null, message: string, level: LogEntry["level"]): void {
    this.options.onLog?.({ time: this.time, systemId, message, level });
  }
}

/**
 * フィールドの値（JSON で表せる値）の複製。毎ステップ全 Entity 分呼ばれるので、
 * structuredClone（数値 1 つでも重い）を避け、数値・文字列などはそのまま返す。
 */
function cloneJson<T extends Json>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => cloneJson(x)) as T;
  const out: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v)) out[k] = cloneJson(x as Json);
  return out as T;
}

function accepts(f: FieldDef, v: Json): boolean {
  switch (f.type) {
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "string":
      return typeof v === "string";
    case "color":
      return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
    case "vec3":
      return (
        Array.isArray(v) &&
        v.length === 3 &&
        v.every((n) => typeof n === "number" && Number.isFinite(n))
      );
    case "entity":
    case "resource":
      return v === null || typeof v === "string";
  }
}
