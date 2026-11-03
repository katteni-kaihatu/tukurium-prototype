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
  isBuiltin,
  type MaterialDef,
  type ProjectSnapshot,
} from "@tukurium/repo-model";
import {
  type HostCallContext,
  type Json,
  type ScriptEntity,
  ScriptError,
  ScriptSandbox,
} from "@tukurium/script";
import { buildWorld } from "./buildWorld";
import { type CollisionEvent, initPhysics, Physics } from "./physics";
import { worldTransform } from "./transform";

/** 入力の動作。利用者のスクリプトは action 名で受け取る。 */
export interface InputEvent {
  action: string;
  phase: "down" | "up";
  /** 入力した人の視点（レイの始点と向き） */
  origin: Vec3;
  direction: Vec3;
  player: string;
}

export interface SystemStatus {
  id: string;
  name: string;
  enabled: boolean;
  /** 読み込みや実行で止まった理由 */
  error: string | null;
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
}

interface PendingEvent {
  target: EntityId;
  name: string;
  data: Json;
}

const MAX_EVENTS_PER_STEP = 256;

/** スクリプトから呼べる API（名前空間.関数名）。 */
const HOST_API = [
  "world.raycast",
  "world.emit",
  "world.get",
  "world.set",
  "world.find",
  "world.spawn",
  "world.destroy",
  "time.now",
  "audio.play",
] as const;
type HostName = (typeof HOST_API)[number];

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
  private inputs: InputEvent[] = [];
  private pending: PendingEvent[] = [];
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
    if (this.parts.has(spec.id)) this.removePart(spec.id);
    const part: Part = { ...spec, entities: new Set() };
    this.parts.set(part.id, part);
    this.registerRealm(part.realm, part.snapshot);
    this.instantiate(part);
    this.loadSystems(part);
  }

  removePart(id: string): void {
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
    const part = this.parts.get(id);
    if (!part) return;
    this.clearEntities(part);
    this.instantiate(part);
  }

  /** この間に鳴らされた音を取り出す */
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
    }));
  }

  nameOf(id: EntityId): string {
    return this.names.get(id) ?? id;
  }

  /**
   * 別のホストから引き継いだ状態にする（ADR 0002）。物理ワールドは EKS の値（Transform・速度）から作り直す。
   */
  restore(world: WorldSnapshot, names: Record<string, string>, time: number): void {
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
      for (const sys of this.active("onInput"))
        this.runSystem(sys, "onInput", this.matches(sys), [ev as unknown as Json]);
    }

    for (const sys of this.active("onUpdate"))
      this.runSystem(sys, "onUpdate", this.matches(sys), [dt]);

    let budget = MAX_EVENTS_PER_STEP;
    while (this.pending.length > 0 && budget-- > 0) {
      const ev = this.pending.shift() as PendingEvent;
      if (!this.world.has(ev.target)) continue;
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
      };
      this.systems.push(sys);
      if (!ref.enabled) continue;
      try {
        const meta = this.sandbox.loadSystem(id, def.code, part.realm);
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

  private callHost(name: HostName, args: Json[], ctx: HostCallContext): Json | undefined {
    const scope = this.scopeOfRealm(ctx.realm);
    const vec3 = (v: Json): Vec3 => {
      if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === "number")) {
        throw new TypeError("[x, y, z] の形の数値の配列を渡してください");
      }
      return v as Vec3;
    };
    const entityId = (v: Json): EntityId => {
      if (typeof v !== "string") throw new TypeError("Entity の ID（文字列）を渡してください");
      return v;
    };
    const api: Record<HostName, (args: Json[]) => Json | undefined> = {
      "world.raycast": ([origin, direction, max, opts]) => {
        const exclude =
          opts && typeof opts === "object" && !Array.isArray(opts) && Array.isArray(opts.exclude)
            ? (opts.exclude as string[])
            : [];
        const hit = this.physics.raycast(
          vec3(origin ?? null),
          vec3(direction ?? null),
          typeof max === "number" ? max : 100,
          exclude,
        );
        return hit ? { entity: hit.entity, distance: hit.distance, point: hit.point } : null;
      },
      "world.emit": ([target, name, data]) => {
        if (typeof name !== "string") throw new TypeError("イベント名（文字列）を渡してください");
        this.pending.push({ target: entityId(target ?? null), name, data: data ?? null });
        return undefined;
      },
      "world.get": ([id, kokoName]) => {
        const koko = typeof kokoName === "string" ? this.registry.idOf(kokoName, scope) : undefined;
        if (!koko || typeof id !== "string" || !this.world.hasState(id, koko)) return null;
        return this.toNamed(koko, this.world.get(id, koko) ?? {});
      },
      "world.set": ([id, kokoName, values]) => {
        const koko = typeof kokoName === "string" ? this.registry.idOf(kokoName, scope) : undefined;
        if (!koko || typeof id !== "string" || !this.world.hasState(id, koko)) return false;
        if (!values || typeof values !== "object" || Array.isArray(values)) return false;
        this.writeNamed(id, koko, values as Record<string, Json>, null);
        return true;
      },
      "world.find": ([name]) => {
        for (const [id, n] of this.names) if (n === name && this.world.has(id)) return id;
        return null;
      },
      "world.spawn": ([desc]) => {
        const d = (desc && typeof desc === "object" && !Array.isArray(desc) ? desc : {}) as Record<
          string,
          Json
        >;
        const parent = typeof d.parent === "string" && this.world.has(d.parent) ? d.parent : null;
        const id = this.world.spawn(undefined, parent);
        this.names.set(id, typeof d.name === "string" ? d.name : id);
        const states = (d.states && typeof d.states === "object" ? d.states : {}) as Record<
          string,
          Json
        >;
        for (const [kokoName, values] of Object.entries(states)) {
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
        if (typeof id === "string") this.world.destroy(id);
        return undefined;
      },
      "time.now": () => this.time,
      "audio.play": ([clip, entity, volume]) => {
        // clip：素材の名前か ID。null なら entity の AudioSource の clip を鳴らす
        const target = typeof entity === "string" && this.world.has(entity) ? entity : null;
        const source = target ? this.world.get(target, BUILTIN.AudioSource) : undefined;
        const assets = this.realmAssets.get(ctx.realm) ?? [];
        const ref = typeof clip === "string" ? clip : (source?.clip as string | null | undefined);
        const asset =
          assets.find((a) => a.kind === "audio" && (a.name === ref || a.id === ref))?.id ??
          (typeof ref === "string" && /^[0-9a-f]{64}$/.test(ref) ? ref : null);
        if (!asset) return false;
        const pos = target ? worldTransform(this.world, target).position : null;
        const vol =
          typeof volume === "number"
            ? volume
            : typeof source?.volume === "number"
              ? source.volume
              : 1;
        if (this.sounds.length < 32) {
          this.sounds.push({ asset, position: pos ? [pos.x, pos.y, pos.z] : null, volume: vol });
        }
        return true;
      },
    };
    return api[name](args);
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
    this.log(sys.id, `${sys.name} を停止しました：${sys.error}`, "error");
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
