import type {
  EntityId,
  FieldDef,
  FieldValue,
  KokoStateId,
  KokoStateRegistry,
  Vec3,
} from "@tukurium/eks";
import { World, type WorldSnapshot } from "@tukurium/eks";
import { buildRegistry, type ProjectSnapshot } from "@tukurium/repo-model";
import {
  type HostCallContext,
  type Json,
  type ScriptEntity,
  ScriptError,
  ScriptSandbox,
} from "@tukurium/script";
import { buildWorld } from "./buildWorld";
import { type CollisionEvent, initPhysics, Physics } from "./physics";

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

interface LoadedSystem {
  id: string;
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
] as const;
type HostName = (typeof HOST_API)[number];

/**
 * 1 つのアウトプットを実行する。EKS の World ＋ 物理 ＋ スクリプト。
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
  private inputs: InputEvent[] = [];
  private pending: PendingEvent[] = [];
  private disposed = false;

  private constructor(
    private readonly sandbox: ScriptSandbox,
    private physics: Physics,
    registry: KokoStateRegistry,
    private readonly options: SimulationOptions,
  ) {
    this.registry = registry;
    this.world = new World(registry);
  }

  static async create(
    snapshot: ProjectSnapshot,
    outputId: string,
    options: SimulationOptions,
  ): Promise<Simulation> {
    await initPhysics();
    const registry = buildRegistry(snapshot.kokostates);
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
    const sim = new Simulation(sandbox, new Physics(), registry, options);
    ref.sim = sim;
    sim.loadEntities(snapshot, outputId);
    sim.loadSystems(snapshot, outputId);
    return sim;
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

  private loadEntities(snapshot: ProjectSnapshot, outputId: string): void {
    const { world, names } = buildWorld(snapshot, outputId, this.registry);
    this.world.restore(world.snapshot());
    for (const [id, n] of names) this.names.set(id, n);
  }

  private loadSystems(snapshot: ProjectSnapshot, outputId: string): void {
    const output = snapshot.outputs.find((o) => o.id === outputId);
    if (!output) throw new Error(`Unknown output: ${outputId}`);
    for (const ref of output.systems) {
      const def = snapshot.systems.find((s) => s.id === ref.id);
      if (!def) continue;
      const sys: LoadedSystem = {
        id: def.id,
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
        const meta = this.sandbox.loadSystem(def.id, def.code, this.options.realm);
        const resolve = (names: string[]) =>
          names.map((n) => {
            const id = this.registry.idOf(n);
            if (!id)
              throw new ScriptError(`Query の KokoState「${n}」が見つかりません`, def.id, "load");
            return id;
          });
        sys.with = resolve(meta.query.with);
        sys.without = resolve(meta.query.without);
        sys.handlers = new Set(meta.handlers);
      } catch (e) {
        this.fail(sys, e);
      }
    }
  }

  private callHost(name: HostName, args: Json[], _ctx: HostCallContext): Json | undefined {
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
        const koko = typeof kokoName === "string" ? this.registry.idOf(kokoName) : undefined;
        if (!koko || typeof id !== "string" || !this.world.hasState(id, koko)) return null;
        return this.toNamed(koko, this.world.get(id, koko) ?? {});
      },
      "world.set": ([id, kokoName, values]) => {
        const koko = typeof kokoName === "string" ? this.registry.idOf(kokoName) : undefined;
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
          const koko = this.registry.idOf(kokoName);
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
          const koko = this.registry.idOf(kokoName);
          if (!koko || !this.world.hasState(e.id, koko) || !values || typeof values !== "object")
            continue;
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
      out[f.name] = structuredClone(values[f.id]) as Json;
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
      if (accepts(f, v)) target[f.id] = structuredClone(v) as FieldValue;
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
