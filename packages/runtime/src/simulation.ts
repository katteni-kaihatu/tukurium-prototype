import type {
  EntityId,
  FieldDef,
  FieldValue,
  KokoStateDef,
  KokoStateId,
  KokoStateRegistry,
  KokoStateValues,
  Vec3,
} from "@tukurium/eks";
import {
  acceptsUndefined,
  cloneValue,
  conformValue,
  decodeValue,
  encodeValue,
  equalValues,
  type FieldSchemas,
  hasRefs,
  isJsonSafe,
  mapRefs,
  schemaOfField,
  stringifyValue,
  type Value,
  type ValueSchema,
  validateValue,
  World,
  type WorldSnapshot,
} from "@tukurium/eks";
import {
  type AssetDef,
  BUILTIN,
  buildRegistry,
  type CapabilityId,
  compileSystem,
  expandPrefabs,
  type GuestPolicy,
  HOST_CAPABILITIES,
  inferCapabilities,
  instrumentDebug,
  isBuiltin,
  isPackageResourceId,
  librarySnapshot,
  type MaterialDef,
  type OutputExposure,
  type PackageResolution,
  type ProjectSnapshot,
  packageFieldSchemas,
  packageKokoStates,
  parsePackageResourceId,
  ResourcePathIndex,
  reachablePackages,
  resolutionMap,
  withPackagePrefabs,
} from "@tukurium/repo-model";
import {
  type DebugKokoState,
  type DebugStateEdit,
  type HostCallContext,
  type ScriptEntity,
  ScriptError,
  ScriptSandbox,
  type TaggedFields,
} from "@tukurium/script";
import { buildWorld } from "./buildWorld";
import type { PackageExecutionContext, PackageId } from "./capabilities";
import { HOST_ONLY_CONTRACTS, isContractName, parseContractPayload } from "./contracts";
import { DebugRuntime, type RuntimeDebugOptions } from "./debugRuntime";
import {
  equippedBy,
  equipper,
  grabbedBy,
  isAuthoredTop,
  isInHand,
  isSpaceRoot,
  SPACE_ROOT_ID,
} from "./holding";
import { type HostArgs, parseHostArgs } from "./hostApi";
import { HOST_API_SPEC } from "./hostApiSpec";
import { type CollisionEvent, initPhysics, Physics } from "./physics";
import {
  degreesToQuaternion,
  moveAlongView,
  placeFromView,
  poseInView as poseRelativeToView,
  quaternionToDegrees,
  straightenRotation,
  transformOf,
  twistRotation,
  worldTransform,
  writeTransform,
  writeWorldTransform,
} from "./transform";

/** 入力の動作。利用者のスクリプトは action 名で受け取る。 */
/** 右クリックで物を持てる距離（m） */
const GRAB_REACH = 6;

/** 適用の前後で保つ、手に持っている・装備している Entity の状態 */
interface InHandState {
  id: EntityId;
  tool: KokoStateValues | null;
  grab: KokoStateValues | null;
  position: Vec3;
  rotation: Vec3;
}

export interface InputEvent {
  action: string;
  phase: "down" | "up";
  /** 入力した人の視点（レイの始点と向き） */
  origin: Vec3;
  direction: Vec3;
  player: string;
  /** 表示名。無いときは空。今はクライアントの申告を信じる（player の ID はサーバーが本人で上書きする。ADR 0018） */
  playerName?: string;
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
  /** 止まるほどではない注意（拒否など。同じものは回数を数える。ADR 0012） */
  warnings: RuntimeWarning[];
}

export interface RuntimeWarning {
  code: string;
  message: string;
  count: number;
}

export interface LogEntry {
  time: number;
  systemId: string | null;
  message: string;
  level: "log" | "error";
}

export interface SimulationOptions {
  debug?: RuntimeDebugOptions;
  /** スクリプトの領域（リポジトリ単位）。別リポジトリの System とは別の VM になる。 */
  realm: string;
  onLog?: (entry: LogEntry) => void;
  timeLimitMs?: number;
  /** 依存の中身（ワークスペースの再生。ADR 0015） */
  packages?: PackageResolution[];
  /** フィールドのスキーマ（ワークスペースの再生。TypeScript で作ったもの。ADR 0065） */
  schemas?: FieldSchemas;
}

/** セッションに配置された実体（アウトプットの 1 回分の配置） */
export interface PartSpec {
  id: string;
  /** リポジトリ（ワークスペース）。KokoState の名前とスクリプトの領域はこの単位で分かれる */
  realm: string;
  outputId: string;
  snapshot: ProjectSnapshot;
  /** 依存の中身（制作データの依存ごとの解決。ないものは使えない依存になる。ADR 0015） */
  packages?: PackageResolution[];
  /**
   * フィールドのスキーマ（TypeScript で作ったもの。KokoState の ID は制作データの中の ID。ADR 0065）。
   * なくても、Tukurium が用意する型のフィールドは確かめる。スキーマが分からないフィールドは、
   * 値の確かめをせずに通す。
   */
  schemas?: FieldSchemas;
  /** 配置の位置と向き（動作上の親 Entity の姿勢。中の Entity には足さない） */
  position: Vec3;
  yaw: number;
  /**
   * 置いた物への付与（ADR 0012）。ないときは、その物の System がコードから読み取った宣言をそのまま付与する。
   * 細かく取り消す画面は U5 で作る
   */
  grants?: CapabilityId[];
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
/** E（use）で押せる距離（m） */
const INTERACT_RANGE = 3;
/** 一つのバッグに入る数（ADR 0018） */
export const BAG_LIMIT = 64;
/** バッグの値 1 つの大きさの上限（値の形式の文字数） */
const BAG_VALUE_LIMIT = 1024;

/**
 * バッグの中の 1 個（ADR 0018）。種類はライブラリの KokoState（`pkg:` の ID）、値はフィールドの名前で持つ
 * （その種類のライブラリが読み込まれていなくても、表示と引き継ぎができるように）。
 */
export interface BagItem {
  type: KokoStateId;
  /** 種類の表示名 */
  name: string;
  values: Record<string, Value>;
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
  /** 置いたときのリポジトリ（ワークスペース）。realm は、セッションではこれに版を付けたもの */
  source: string;
  entities: Set<EntityId>;
}

/**
 * 依存から取り込んだ KokoState を登録する範囲。名前での引き当て（移行の間の書き方）には出てこない。
 * Built-in と同じく、どの realm からも同じ ID で使う（同じライブラリの同じ版は、置いた物どうしで共有。ADR 0015）
 */
const PACKAGE_SCOPE = "\u0000package";

/**
 * ライブラリの System を動かす VM の領域。使うプロジェクト（realm）とライブラリの版ごとに分ける
 * （同じライブラリでも、使うプロジェクトが違えば変数は混ざらない。使う側のスクリプトとも別の VM。ADR 0015）
 */
const libraryVm = (realm: string, packageId: string, version: number) =>
  `${realm}|pkg:${packageId}@${version}`;
const isLibraryVm = (realm: string) => realm.includes("|pkg:");

/** realm で区切らない KokoState（Built-in と、依存から取り込んだもの） */
const isShared = (id: KokoStateId) => isBuiltin(id) || isPackageResourceId(id);

/** 制作データの版（同じ中身なら、どのホストでも同じ値。FNV-1a） */
function revisionOf(snapshot: ProjectSnapshot): string {
  const text = stringifyValue(snapshot);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
  warnings: Map<string, RuntimeWarning>;
  /** コードから読み取った、要る Capability（宣言） */
  capabilities: Set<CapabilityId>;
}

interface PendingEvent {
  /** event：同じ配置の中のイベント（onEvent）、contract：公開 Contract（contracts.名前） */
  kind: "event" | "contract";
  target: EntityId;
  name: string;
  data: Value;
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

/** 実効権限で拒んだときに Host API が返す値（HOST_API_SPEC から作る） */
const DENIED_RESULT = Object.fromEntries(
  Object.entries(HOST_API_SPEC).map(([name, spec]) => [name, spec.denied]),
) as Record<HostName, Value>;

/** handle の寿命（秒） */
const HANDLE_TTL = 1;

const MAX_EVENTS_PER_STEP = 256;

/** スクリプトから呼べる API（名前空間.関数名）。 */
export const HOST_API = [
  "world.raycast",
  "world.emit",
  "world.get",
  "world.set",
  "world.getState",
  "world.setState",
  "world.getField",
  "world.setField",
  "world.find",
  "world.spawn",
  "world.destroy",
  "time.now",
  "audio.play",
  "contract.send",
  "effects.spawn",
  "bag.add",
  "bag.take",
  "bag.count",
  "bag.list",
] as const;
export type HostName = (typeof HOST_API)[number];

/**
 * アウトプットを実行する。EKS の World ＋ 物理 ＋ スクリプト。
 *
 * - ワークスペースの再生では、1 つのアウトプットをそのまま（ID を付け替えずに）実行する（create）。
 * - セッションでは、複数のリポジトリのアウトプットを「配置」として同じ世界に置く（createSession / addPart）。
 *   どちらの実行でも、アイテムとワールドには動作上の親 Entity を一つ作る。配置の位置と向きは
 *   その親だけが持ち、中の Entity の姿勢は制作データのまま（親からのずれ）にする（ADR 0057）。
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
  debug: DebugRuntime | null = null;
  private debugRunning = false;
  private activeDebugApply: ((entities: ScriptEntity[]) => void) | null = null;
  readonly world: World;
  readonly registry: KokoStateRegistry;
  time = 0;
  private readonly systems: LoadedSystem[] = [];
  private readonly names = new Map<EntityId, string>();
  private readonly parts = new Map<string, Part>();
  private readonly realmDefs = new Map<string, Set<KokoStateId>>();
  /** 登録した KokoState（実行時の ID）→ フィールドの ID → スキーマ */
  private readonly schemas = new Map<KokoStateId, Record<string, ValueSchema>>();
  /** realm が使う、依存から取り込んだ KokoState（どの realm も使わなくなったら外す） */
  private readonly realmPackageDefs = new Map<string, Set<KokoStateId>>();
  private readonly realmMaterials = new Map<string, MaterialDef[]>();
  private readonly realmAssets = new Map<string, AssetDef[]>();
  private sounds: SoundEvent[] = [];
  private effects: EffectEvent[] = [];
  private inputs: InputEvent[] = [];
  private pending: PendingEvent[] = [];
  private readonly handles = new Map<string, HitHandle>();
  /** プレイヤー → バッグ（どの配置にも属さない。セッションの間だけ。ADR 0018） */
  private bags = new Map<string, BagItem[]>();
  /** いま Interact を受けている System と、押した人（bag.* はこの間だけ使える） */
  private interacting: { systemId: string; player: string } | null = null;
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
          (args: Value[], ctx: HostCallContext) => ref.sim?.callHost(name, args, ctx),
        ]),
      ),
      onLog: (message, ctx) => ref.sim?.log(ctx.systemId, message, "log"),
      ...(options.debug
        ? {
            debug: {
              onPoint: async (point) =>
                ref.sim?.debug?.point(point, (entities) => {
                  const sim = ref.sim;
                  if (!sim) return () => {};
                  const runningWorld = sim.world.snapshot();
                  sim.activeDebugApply?.(entities);
                  return (edits) => {
                    if (!sim.disposed) {
                      sim.world.restore(runningWorld);
                      for (const edit of edits)
                        if (edit.kind === "state") sim.writeDebugState(edit);
                    }
                  };
                }) ?? [],
            },
          }
        : {}),
    });
    const sim = new Simulation(sandbox, new Physics(), multi, options);
    ref.sim = sim;
    if (options.debug)
      sim.debug = new DebugRuntime(options.debug, {
        states: (entity) => sim.debugStates(entity),
        writeState: (edit) => sim.writeDebugState(edit),
      });
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
      ...(options.packages ? { packages: options.packages } : {}),
      ...(options.schemas ? { schemas: options.schemas } : {}),
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
    const part: Part = {
      ...spec,
      // プレハブのインスタンスは、ここで中身に展開しておく（ADR 0076）。版（realm）は、渡された制作データから決める
      snapshot: this.expand(spec.snapshot, spec.packages, spec.schemas),
      realm: this.realmOf(spec.realm, spec.snapshot),
      source: spec.realm,
      entities: new Set(),
    };
    this.parts.set(part.id, part);
    this.registerRealm(part.realm, part.snapshot, part.packages, part.schemas);
    this.instantiate(part);
    this.loadSystems(part);
  }

  /** プレハブのインスタンスを中身に展開した制作データ（Entity・System の並び・「維持」の印。ADR 0076） */
  private expand(
    snapshot: ProjectSnapshot,
    packages?: PackageResolution[],
    schemas?: FieldSchemas,
  ): ProjectSnapshot {
    const combinedSchemas = packageFieldSchemas(
      reachablePackages(snapshot.dependencies, packages),
      schemas,
    );
    return expandPrefabs(withPackagePrefabs(snapshot, packages, schemas), {
      kokostates: packageKokoStates(reachablePackages(snapshot.dependencies, packages)),
      schemas: combinedSchemas,
    });
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
    this.dropUnusedRealm(part.realm);
  }

  /**
   * セッションでは、配置の realm を「リポジトリ@版」にする（ADR 0010 §4）。同じ realm に
   * 違う版の定義と System を混ぜないため。同じ中身なら同じ版なので、ホストが替わっても同じ realm になる。
   */
  private realmOf(source: string, snapshot: ProjectSnapshot): string {
    return this.multi ? `${source}@${revisionOf(snapshot)}` : source;
  }

  /** どの配置も使わなくなった realm の定義・マテリアル・素材・スクリプトの領域を片付ける */
  private dropUnusedRealm(realm: string): void {
    if ([...this.parts.values()].some((p) => p.realm === realm)) return;
    for (const k of this.realmDefs.get(realm) ?? []) this.registry.unregister(k);
    this.realmDefs.delete(realm);
    this.releasePackageDefs(realm, new Set());
    this.realmMaterials.delete(realm);
    this.realmAssets.delete(realm);
    for (const sys of [...this.systems])
      if (sys.realm === realm || sys.realm.startsWith(`${realm}|pkg:`)) this.dropSystem(sys);
    this.sandbox.disposeRealm(realm);
  }

  /** 置いた物への付与を変える（null は宣言どおり。ADR 0012） */
  setGrants(partId: string, grants: CapabilityId[] | null): void {
    const part = this.parts.get(partId);
    if (!part) return;
    if (grants === null) delete part.grants;
    else part.grants = [...grants];
  }

  /** 置いた物の System が、コードから読み取った要る Capability（宣言）の和 */
  declaredCapabilities(partId: string): CapabilityId[] {
    const caps = new Set<CapabilityId>();
    for (const sys of this.systems)
      if (sys.users.has(partId)) for (const c of sys.capabilities) caps.add(c);
    return [...caps].sort();
  }

  /**
   * 実行の主体（ADR 0012・0013）。ライブラリの System なら、その Package（作品の ID・版・content hash）。
   * それ以外は、ワークスペースの出力を暗黙の Package とする
   */
  executionContext(partId: string, systemId: string): PackageExecutionContext | undefined {
    const part = this.parts.get(partId);
    if (!part) return undefined;
    const ref = parsePackageResourceId(systemId);
    const dep = ref
      ? part.snapshot.dependencies?.find(
          (d) => d.packageId === ref.packageId && d.version === ref.version,
        )
      : undefined;
    if (dep)
      return {
        packageInstanceId: `${part.id}|${dep.packageId}@${dep.version}`,
        packageId: dep.packageId as PackageId,
        resolvedVersion: String(dep.version),
        contentHash: dep.contentHash,
        systemId,
        placementId: part.id,
        worldInstanceId: this.baseWorld()?.id ?? "session",
      };
    const revision = part.realm.includes("@") ? part.realm.slice(part.realm.indexOf("@") + 1) : "";
    return {
      packageInstanceId: part.id,
      packageId: `workspace:${part.source}` as PackageId,
      resolvedVersion: revision,
      contentHash: revision,
      systemId,
      placementId: part.id,
      worldInstanceId: this.baseWorld()?.id ?? "session",
    };
  }

  /** バッグの中身（フレームに入れて配る・ホストが替わったら引き継ぐ。ADR 0018） */
  bagsSnapshot(): Record<string, BagItem[]> {
    return Object.fromEntries([...this.bags].map(([p, items]) => [p, structuredClone(items)]));
  }

  /** バッグの中身を戻す（ホストが替わったとき・再生を続けるとき） */
  restoreBags(bags: Record<string, BagItem[]> | undefined): void {
    this.bags = new Map(
      Object.entries(bags ?? {}).map(([p, items]) => [
        p,
        structuredClone(items).slice(0, BAG_LIMIT),
      ]),
    );
  }

  /**
   * bag.* が触れるバッグと種類。Interact を受けている System の中だけで、種類は import した
   * ライブラリの KokoState だけ。使えないときは理由を注意に残して null
   */
  private bagFor(
    ctx: HostCallContext,
    typeRef: string,
  ): { koko: KokoStateId; name: string; items: BagItem[] } | null {
    if (!this.interacting || this.interacting.systemId !== ctx.systemId) {
      this.warn(
        ctx.systemId,
        "bag-outside-interact",
        "バッグに触れられるのは、プレイヤーが E で押した Interact を受けている間だけです",
      );
      return null;
    }
    const koko = this.resolveKoko(typeRef, ctx.realm);
    const def = koko ? this.registry.get(koko) : undefined;
    if (!koko || !def || !isPackageResourceId(koko)) {
      this.warn(
        ctx.systemId,
        "bag-type-invalid",
        "持ち物の種類にできるのは、import したライブラリの KokoState だけです",
      );
      return null;
    }
    const player = this.interacting.player;
    const items = this.bags.get(player) ?? [];
    this.bags.set(player, items);
    return { koko, name: def.name, items };
  }

  /** 持ち物の値：種類の定義のフィールドだけを、型を確かめて入れる（ないものは初期値。参照は入れない） */
  private bagValues(
    koko: KokoStateId,
    given: Record<string, unknown> | undefined,
  ): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const f of this.registry.require(koko).fields) {
      const schema = this.schemaOf(koko, f);
      // Entity・リソースの参照は、配置をまたぐと意味がないので持たない
      if (schema && hasRefs(schema)) {
        out[f.name] = acceptsUndefined(schema) ? undefined : cloneValue(f.default);
        continue;
      }
      const v = given && Object.hasOwn(given, f.name) ? (given[f.name] as Value) : undefined;
      // 型が分からないフィールドは確かめられないので、初期値にする。大きすぎる値も持たない
      const ok =
        schema !== undefined &&
        validateValue(schema, v, { finite: true }) === null &&
        stringifyValue(v).length <= BAG_VALUE_LIMIT;
      out[f.name] = cloneValue(ok ? v : f.default);
    }
    return out;
  }

  /** 配置と、制作データの中の KokoState ID から、実行時の KokoState ID を求める（版付きの realm を含む） */
  stateIdOf(partId: string, kokoId: KokoStateId): KokoStateId | undefined {
    const part = this.parts.get(partId);
    return part ? this.kid(part.realm, kokoId) : undefined;
  }

  partList(): { id: string; realm: string; outputId: string; position: Vec3; yaw: number }[] {
    return [...this.parts.values()].map((p) => ({
      id: p.id,
      realm: p.source,
      outputId: p.outputId,
      position: p.position,
      yaw: p.yaw,
    }));
  }

  /** 実行中に作った物も含め、どの配置がEntityを持つかをフレームへ記録する。 */
  partEntitiesSnapshot(): Record<string, EntityId[]> {
    return Object.fromEntries(
      [...this.parts.values()].map((part) => [
        part.id,
        [...part.entities].filter((id) => this.world.has(id)),
      ]),
    );
  }

  /**
   * 適用：同じリポジトリ・アウトプットの配置を、新しい制作データで作り直す（要件 §7）。
   * 状態維持のマークがあり、型が変わっていないフィールドだけ、現在の実行値を引き継ぐ。
   * それ以外の値は新しい制作データの値になる。System のコードも読み直す。
   */
  applyPart(
    source: string,
    outputId: string,
    given: ProjectSnapshot,
    packages?: PackageResolution[],
    schemas?: FieldSchemas,
  ): ApplyReport {
    // 配置や版が変わったら、発行済みの handle は使えなくする（ADR 0012 §6）
    this.handles.clear();
    const targets = [...this.parts.values()].filter(
      (p) => p.source === source && p.outputId === outputId,
    );
    const report: ApplyReport = { instances: targets.length, kept: 0, dropped: 0 };
    if (targets.length === 0) return report;
    // 適用した配置だけを、新しい版の realm へまとめて移す（ほかの出力は古い版のまま。ADR 0010 §4）
    const realm = this.realmOf(source, given);
    // プレハブの変更も、アウトプットの変更の一つとして届く（展開してから比べる。ADR 0076）
    const snapshot = this.expand(given, packages, schemas);
    const marks = snapshot.outputs.find((o) => o.id === outputId)?.keep ?? [];
    const newDefs = new Map(
      [
        ...snapshot.kokostates,
        ...packageKokoStates(reachablePackages(snapshot.dependencies, packages)),
      ].map((d) => [d.id, d]),
    );

    // 1. マークされたフィールドの現在値を集める（古い定義と新しい定義で型が同じものだけ）
    const kept = new Map<
      string,
      { entity: EntityId; koko: KokoStateId; field: string; value: FieldValue }[]
    >();
    for (const part of targets) {
      const list: { entity: EntityId; koko: KokoStateId; field: string; value: FieldValue }[] = [];
      for (const m of marks) {
        const entity = this.eid(part, m.entity);
        const oldKoko = this.kid(part.realm, m.koko);
        const oldField = this.registry.get(oldKoko)?.fields.find((f) => f.id === m.field);
        const newDef = isBuiltin(m.koko) ? this.registry.get(m.koko) : newDefs.get(m.koko);
        const newField = newDef?.fields.find((f) => f.id === m.field);
        const values = this.world.get(entity, oldKoko);
        // undefined も値なので、いまの値があるかはキーで見る
        if (
          oldField &&
          newField &&
          oldField.type === newField.type &&
          values &&
          m.field in values
        ) {
          list.push({
            entity,
            koko: this.kid(realm, m.koko),
            field: m.field,
            value: cloneValue(values[m.field]),
          });
          report.kept++;
        } else {
          report.dropped++;
        }
      }
      kept.set(part.id, list);
    }

    // 装備・右クリックで持っている物は、作り直しても手に持ったままにする（遊んでいる最中に手から消えないように。ADR 0053）
    const inHand = targets.flatMap((part) => this.inHandOf(part));

    // 2. System を外し、配置を新しい版で作り直す
    const ids = new Set(targets.map((p) => p.id));
    for (const sys of [...this.systems]) {
      for (const id of ids) sys.users.delete(id);
      if (sys.users.size === 0) this.dropSystem(sys);
    }
    const oldRealms = new Set(targets.map((p) => p.realm));
    for (const part of targets) {
      this.clearEntities(part);
      part.snapshot = snapshot;
      part.realm = realm;
      if (packages) part.packages = packages;
      else delete part.packages;
      if (schemas) part.schemas = schemas;
      else delete part.schemas;
    }
    this.registerRealm(realm, snapshot, packages, schemas);
    for (const part of targets) {
      this.instantiate(part);
      for (const k of kept.get(part.id) ?? []) {
        const values = this.world.get(k.entity, k.koko);
        if (!values || !(k.field in values)) continue;
        // 入れ子の値も、フィールドの値をまるごと引き継ぐ。型の文が同じでも、型の定義が変わっていることが
        // あるので、新しい型に合わせる（足りないフィールドを埋め、ないものを捨てる）。それでも合わない値は引き継がない
        const f = this.registry.get(k.koko)?.fields.find((x) => x.id === k.field);
        const schema = f ? this.schemaOf(k.koko, f) : undefined;
        const value = schema ? (conformValue(schema, k.value) as FieldValue) : k.value;
        if (f && !this.accepts(k.koko, f, value)) {
          report.kept--;
          report.dropped++;
          continue;
        }
        values[k.field] = value;
      }
    }
    this.restoreInHand(inHand);

    // 3. System を読み直し、使われなくなった古い版を片付ける
    // 同じSystemは適用ごとに一度だけ読み直し、ほかの配置の利用者も引き継ぐ。
    const reloaded = new Set<string>();
    for (const part of targets) this.loadSystems(part, reloaded);
    for (const old of oldRealms) if (old !== realm) this.dropUnusedRealm(old);
    return report;
  }

  /** 配置の中で、手に持っている・装備している Entity と、その持ち方・いまの位置 */
  private inHandOf(part: Part): InHandState[] {
    const out: InHandState[] = [];
    for (const id of part.entities) {
      if (!this.world.has(id) || !isInHand(this.world, id)) continue;
      const t = transformOf(this.world, id);
      out.push({
        id,
        tool: structuredClone(this.world.get(id, BUILTIN.EquipmentTool) ?? null),
        grab: structuredClone(this.world.get(id, BUILTIN.Grabbable) ?? null),
        position: t.position,
        rotation: t.rotation,
      });
    }
    return out;
  }

  /** 作り直した Entity に、持ち方と位置を戻す（新しい版で道具でなくなったものは戻さない） */
  private restoreInHand(list: InHandState[]): void {
    for (const h of list) {
      if (!this.world.has(h.id)) continue;
      const tool = this.world.get(h.id, BUILTIN.EquipmentTool);
      if (tool && h.tool) tool.player = h.tool.player ?? "";
      const grab = this.world.get(h.id, BUILTIN.Grabbable);
      if (grab && h.grab) {
        grab.player = h.grab.player ?? "";
        if (h.grab.offset !== undefined) grab.offset = h.grab.offset;
        if (h.grab.rotation !== undefined) grab.rotation = h.grab.rotation;
      }
      if (isInHand(this.world, h.id)) writeTransform(this.world, h.id, h.position, h.rotation);
    }
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
      warnings: [...s.warnings.values()].map((w) => ({ ...w })),
    }));
  }

  /** System に注意を残す（同じ code は回数を数える） */
  private warn(systemId: string | null, code: string, message: string): void {
    const sys = this.systems.find((x) => x.id === systemId);
    if (!sys) return;
    const w = sys.warnings.get(code);
    if (w) {
      w.count += 1;
      w.message = message;
    } else sys.warnings.set(code, { code, message, count: 1 });
  }

  nameOf(id: EntityId): string {
    return this.names.get(id) ?? id;
  }

  /**
   * 別のホストから引き継いだ状態にする（ADR 0002）。物理ワールドは EKS の値（Transform・速度）から作り直す。
   */
  restore(
    world: WorldSnapshot,
    names: Record<string, string>,
    time: number,
    partEntities: Record<string, EntityId[]>,
  ): void {
    // 配置や版が変わったら、発行済みの handle は使えなくする（ADR 0012 §6）
    this.handles.clear();
    this.world.restore(world);
    for (const part of this.parts.values()) {
      const entities = partEntities[part.id] ?? [];
      part.entities = new Set(entities.filter((id) => this.world.has(id)));
    }
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
      if (this.equipInput(ev)) continue;
      this.deliverInteract(ev);
      if (this.builtinInput(ev)) continue;
      // 装備する道具（EquipmentTool）は、装備している人の入力だけを受け取る（ADR 0053）
      for (const sys of this.active("onInput")) {
        const targets = this.matches(sys).filter((id) => this.acceptsInput(id, ev.player));
        this.runSystem(sys, "onInput", targets, [ev as unknown as Value]);
      }
    }

    for (const sys of this.active("onUpdate"))
      this.runSystem(sys, "onUpdate", this.matches(sys), [dt]);

    let budget = MAX_EVENTS_PER_STEP;
    while (this.pending.length > 0 && budget-- > 0) {
      const ev = this.pending.shift() as PendingEvent;
      if (!this.world.has(ev.target)) continue;
      if (ev.kind === "contract") {
        const handler = `contract:${ev.name}`;
        const player =
          ev.name === "Interact"
            ? ((ev.data as { player?: unknown } | null)?.player ?? null)
            : null;
        for (const sys of this.active(handler))
          if (this.entityMatches(sys, ev.target)) {
            // Interact を受けている間だけ、押した人のバッグに触れられる（ADR 0018）
            this.interacting = typeof player === "string" ? { systemId: sys.id, player } : null;
            try {
              this.runSystem(sys, handler, [ev.target], [ev.data]);
            } finally {
              this.interacting = null;
            }
          }
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

  /** デバッグだけはフレームの途中で待つ。通常の step の順序をそのまま保つ。 */
  async stepDebug(dt: number): Promise<void> {
    if (!this.debug || this.disposed || this.debugRunning) return;
    this.debugRunning = true;
    try {
      await this.debug.beginFrame();
      if (this.disposed) return;
      this.time += dt;
      this.physics.sync(this.world);
      const collisions = this.physics.step(this.world, dt);
      for (const c of collisions)
        for (const [self, other] of [
          [c.a, c.b],
          [c.b, c.a],
        ]) {
          if (!self || !other || !this.world.has(self)) continue;
          for (const sys of this.active("onCollision"))
            if (this.entityMatches(sys, self))
              await this.runSystemDebug(
                sys,
                "onCollision",
                [self],
                [{ other, started: c.started }],
              );
        }
      const inputs = this.inputs;
      this.inputs = [];
      for (const ev of inputs) {
        if (this.equipInput(ev)) continue;
        this.deliverInteract(ev);
        if (this.builtinInput(ev)) continue;
        for (const sys of this.active("onInput")) {
          const targets = this.matches(sys).filter((id) => this.acceptsInput(id, ev.player));
          await this.runSystemDebug(sys, "onInput", targets, [ev as unknown as Value]);
        }
      }
      for (const sys of this.active("onUpdate"))
        await this.runSystemDebug(sys, "onUpdate", this.matches(sys), [dt]);
      let budget = MAX_EVENTS_PER_STEP;
      while (this.pending.length > 0 && budget-- > 0 && !this.disposed) {
        const ev = this.pending.shift() as PendingEvent;
        if (!this.world.has(ev.target)) continue;
        if (ev.kind === "contract") {
          const handler = `contract:${ev.name}`;
          const player =
            ev.name === "Interact"
              ? ((ev.data as { player?: unknown } | null)?.player ?? null)
              : null;
          for (const sys of this.active(handler))
            if (this.entityMatches(sys, ev.target)) {
              this.interacting = typeof player === "string" ? { systemId: sys.id, player } : null;
              try {
                await this.runSystemDebug(sys, handler, [ev.target], [ev.data]);
              } finally {
                this.interacting = null;
              }
            }
        } else
          for (const sys of this.active("onEvent"))
            if (this.entityMatches(sys, ev.target))
              await this.runSystemDebug(
                sys,
                "onEvent",
                [ev.target],
                [{ name: ev.name, data: ev.data }],
              );
      }
      if (this.pending.length > 0) {
        this.log(null, `イベントが多すぎるため ${this.pending.length} 件を捨てました`, "error");
        this.pending = [];
      }
      await this.debug.endFrame();
    } finally {
      this.debugRunning = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.debug?.dispose();
    this.sandbox.dispose();
    this.physics.dispose();
  }

  // ---------------------------------------------------------------------------

  private kid(realm: string, id: KokoStateId): KokoStateId {
    return this.multi && !isShared(id) ? `${realm}:${id}` : id;
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

  /** 実行時の KokoState の ID を、その領域のスクリプトに見せるキー（領域の中の ID）にする */
  private localKey(koko: KokoStateId, realm: string): string {
    const prefix = `${realm}:`;
    return this.multi && !isShared(koko) && koko.startsWith(prefix)
      ? koko.slice(prefix.length)
      : koko;
  }

  /**
   * スクリプトが指した KokoState（import した ID・Built-in の ID・移行の間の名前）を、実行時の ID にする。
   * 名前が同じ領域の中で一つに決まらないときは undefined（ADR 0010）。
   */
  private resolveKoko(ref: string, realm: string): KokoStateId | undefined {
    const scoped = this.kid(realm, ref);
    if (
      this.registry.get(scoped) &&
      (isShared(scoped) || this.registry.scopeOf(scoped) === this.scopeOfRealm(realm))
    )
      return scoped;
    return this.registry.idOf(ref, this.scopeOfRealm(realm));
  }

  /** リポジトリの KokoState 定義とマテリアルを登録し直す */
  private registerRealm(
    realm: string,
    snapshot: ProjectSnapshot,
    packages?: PackageResolution[],
    schemas?: FieldSchemas,
  ): void {
    schemas = packageFieldSchemas(reachablePackages(snapshot.dependencies, packages), schemas);
    const scope = this.scopeOfRealm(realm);
    const next = new Set<KokoStateId>();
    for (const k of this.realmDefs.get(realm) ?? []) {
      this.registry.unregister(k);
      this.schemas.delete(k);
    }
    for (const def of snapshot.kokostates) {
      const id = this.kid(realm, def.id);
      this.registry.register({ ...def, id }, scope);
      this.rememberSchemas(id, def, schemas);
      next.add(id);
    }
    this.realmDefs.set(realm, next);
    // 依存（依存の依存も）から取り込んだ KokoState（同じ ID は同じ Package・同じ版なので、中身も同じ）
    const pkgDefs = packageKokoStates(reachablePackages(snapshot.dependencies, packages));
    for (const def of pkgDefs) {
      this.registry.register(def, PACKAGE_SCOPE);
      this.rememberSchemas(def.id, def, schemas);
    }
    this.releasePackageDefs(realm, new Set(pkgDefs.map((d) => d.id)));
    this.realmMaterials.set(
      realm,
      snapshot.materials.map((m) => ({ ...m, id: this.mid(realm, m.id) })),
    );
    this.realmAssets.set(realm, snapshot.assets ?? []);
  }

  /** 登録した KokoState のフィールドのスキーマを覚える（id は実行時の ID、def.id は制作データの中の ID） */
  private rememberSchemas(id: KokoStateId, def: KokoStateDef, given?: FieldSchemas): void {
    const out: Record<string, ValueSchema> = {};
    for (const f of def.fields) {
      const schema = schemaOfField(given, def.id, f);
      if (schema) out[f.id] = schema;
    }
    this.schemas.set(id, out);
  }

  /**
   * フィールドのスキーマ。Built-in は型の文から分かる。分からないとき（型エラーでスキーマを作れない、
   * まだ TypeScript の準備ができていない）は undefined で、値の確かめをせずに通す（ADR 0065）。
   */
  private schemaOf(koko: KokoStateId, f: FieldDef): ValueSchema | undefined {
    return (
      this.schemas.get(koko)?.[f.id] ??
      (isBuiltin(koko) ? schemaOfField(undefined, koko, f) : undefined)
    );
  }

  /** スクリプトなどが書こうとした値を、そのフィールドに入れてよいか */
  private accepts(koko: KokoStateId, f: FieldDef, v: Value): boolean {
    const schema = this.schemaOf(koko, f);
    // Built-in の数（位置・速度など）は描画と物理がそのまま使うので、有限の数に限る
    return !schema || validateValue(schema, v, { finite: isBuiltin(koko) }) === null;
  }

  /** realm が使う依存の KokoState を next にし、どの realm も使わなくなったものを外す */
  private releasePackageDefs(realm: string, next: Set<KokoStateId>): void {
    const before = this.realmPackageDefs.get(realm) ?? new Set<KokoStateId>();
    if (next.size > 0) this.realmPackageDefs.set(realm, next);
    else this.realmPackageDefs.delete(realm);
    for (const id of before) {
      if (next.has(id)) continue;
      if ([...this.realmPackageDefs.values()].some((ids) => ids.has(id))) continue;
      this.registry.unregister(id);
      this.schemas.delete(id);
    }
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
    const mine = grabbedBy(this.world, ev.player);
    if (ev.action === "hold") {
      for (const id of mine) this.placeHeld(id, ev);
      for (const id of equippedBy(this.world, ev.player)) this.placeEquipped(id, ev);
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
        const grab = this.world.get(id, BUILTIN.Grabbable);
        if (grab) grab.player = "";
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
    if (!target || !isAuthoredTop(this.world, target)) return true;
    // ほかの人が持っている・装備している物は取れない
    if (isInHand(this.world, target)) return true;
    const grab = this.world.get(target, BUILTIN.Grabbable);
    if (!grab) return true;
    const pose = this.poseInView(target, ev);
    grab.player = ev.player;
    grab.offset = pose.offset;
    grab.rotation = pose.rotation;
    return true;
  }

  /**
   * 装備（ADR 0053）。処理したら true（スクリプトの onInput にも Interact にも渡さない）。
   * - equip（左クリックで開くリングメニューの「装備する」）：見ている物か、その親のうち、置いてある EquipmentTool を
   *   右手に装備する。装備していた物は、その場に落とす
   * - unequip（リングメニューの「装備を外す」）：装備している物を、その場に落とす
   * セッションでは、Interact と同じく、相手の配置の「外からの見え方」がインタラクション可能なときだけ拾える。
   */
  private equipInput(ev: InputEvent): boolean {
    if (ev.phase !== "down") return false;
    if (ev.action === "unequip") {
      for (const id of equippedBy(this.world, ev.player)) this.dropEquipped(id);
      return true;
    }
    if (ev.action !== "equip") return false;
    const hit = this.physics.raycast(ev.origin, ev.direction, INTERACT_RANGE, [
      ...grabbedBy(this.world, ev.player),
      ...equippedBy(this.world, ev.player),
      ...this.privateEntities(),
    ]);
    let target: EntityId | null = hit?.entity ?? null;
    while (target && !this.world.hasState(target, BUILTIN.EquipmentTool))
      target = this.world.parentOf(target);
    // 装備できるのは、いちばん上の Entity で、誰も持っていない・装備していない物だけ
    if (!target || !isAuthoredTop(this.world, target) || isInHand(this.world, target)) return true;
    const part = this.partOf(target);
    if (this.multi && part && this.exposureOf(part) !== "interactive") return true;
    const tool = this.world.get(target, BUILTIN.EquipmentTool);
    if (!tool) return true;
    for (const id of equippedBy(this.world, ev.player)) this.dropEquipped(id);
    tool.player = ev.player;
    const rb = this.world.get(target, BUILTIN.RigidBody);
    if (rb) rb.linvel = [0, 0, 0];
    this.placeEquipped(target, ev);
    return true;
  }

  /** その場に落とす（動く剛体なら落ちる） */
  private dropEquipped(id: EntityId): void {
    const tool = this.world.get(id, BUILTIN.EquipmentTool);
    if (tool) tool.player = "";
    const rb = this.world.get(id, BUILTIN.RigidBody);
    if (rb) rb.linvel = [0, 0, 0];
  }

  /** 装備している道具を、装備している人の右手（視点からの位置）へ置く */
  private placeEquipped(id: EntityId, ev: InputEvent): void {
    const tool = this.world.get(id, BUILTIN.EquipmentTool);
    if (!tool) return;
    const placed = placeFromView(
      ev.origin,
      ev.direction,
      (tool.offset as Vec3 | undefined) ?? [0.25, -0.22, -0.5],
      (tool.rotation as Vec3 | undefined) ?? [0, 0, 0],
    );
    this.writeWorldPose(id, placed.position, placed.rotation);
  }

  /** 装備する道具は、装備している人の入力だけを受け取る。ほかの Entity はみんなの入力を受け取る */
  private acceptsInput(id: EntityId, player: string): boolean {
    if (!this.world.hasState(id, BUILTIN.EquipmentTool)) return true;
    return equipper(this.world, id) === player;
  }

  /** セッションで「外からの見え方」が非公開の配置の Entity（レイキャストで見つからない） */
  private privateEntities(): EntityId[] {
    return this.multi
      ? [...this.parts.values()]
          .filter((p) => this.exposureOf(p) === "private")
          .flatMap((p) => [...p.entities])
      : [];
  }

  /**
   * E（use）で見ている物へ、Built-in の Interact を届ける（ADR 0016）。送り手はプレイヤーで、Host が判定する。
   * 自分が持っている物は通り抜け、届くのは INTERACT_RANGE まで。セッションでは、相手の配置の「外からの見え方」が
   * 非公開なら見つからず、衝突のみなら届かない。受け付ける System がなければ何もしない。
   * use の入力そのものは、今までどおり System の onInput にも届く。
   */
  private deliverInteract(ev: InputEvent): void {
    if (ev.action !== "use" || ev.phase !== "down") return;
    const hit = this.physics.raycast(ev.origin, ev.direction, INTERACT_RANGE, [
      ...grabbedBy(this.world, ev.player),
      ...equippedBy(this.world, ev.player),
      ...this.privateEntities(),
    ]);
    if (!hit) return;
    const part = this.partOf(hit.entity);
    if (this.multi && part && this.exposureOf(part) !== "interactive") return;
    const handler = "contract:Interact";
    if (!this.active(handler).some((sys) => this.entityMatches(sys, hit.entity))) return;
    this.pending.push({
      kind: "contract",
      target: hit.entity,
      name: "Interact",
      data: { player: ev.player },
    });
  }

  /** いまのワールドでの位置と角度を、視点からの差として覚える（持った瞬間に動かさないため） */
  private poseInView(id: EntityId, ev: InputEvent): { offset: Vec3; rotation: Vec3 } {
    const t = this.worldPose(id);
    return poseRelativeToView(ev.origin, ev.direction, t.position, t.rotation);
  }

  /** Entity の、ワールド座標系での位置と角度 */
  private worldPose(id: EntityId): { position: Vec3; rotation: Vec3 } {
    const t = worldTransform(this.world, id);
    return { position: t.position.toArray() as Vec3, rotation: quaternionToDegrees(t.quaternion) };
  }

  /**
   * ワールドの位置と角度を、親から見たずれとして Transform に書く。
   * 動作上の親が配置の位置を持っているため、そのまま書くと二重になる（ADR 0050・0057）。
   */
  private writeWorldPose(id: EntityId, position: Vec3, rotation: Vec3): void {
    writeWorldTransform(
      this.world,
      id,
      { x: position[0], y: position[1], z: position[2] },
      degreesToQuaternion(rotation),
    );
  }

  /** 覚えた位置関係のまま、持っている人の視点へ置く（ほかの人にはこの位置で見える） */
  private placeHeld(id: EntityId, ev: InputEvent): void {
    const held = this.world.get(id, BUILTIN.Grabbable);
    if (!held) return;
    const placed = placeFromView(
      ev.origin,
      ev.direction,
      (held.offset as Vec3 | undefined) ?? [0, 0, 0],
      (held.rotation as Vec3 | undefined) ?? [0, 0, 0],
    );
    this.writeWorldPose(id, placed.position, placed.rotation);
  }

  /** 傾きを直し、上下の軸まわりの向きだけ残す */
  private straightenHeld(id: EntityId, ev: InputEvent): void {
    const held = this.world.get(id, BUILTIN.Grabbable);
    if (!held) return;
    const t = this.worldPose(id);
    this.writeWorldPose(id, t.position, straightenRotation(t.rotation));
    const pose = this.poseInView(id, ev);
    held.rotation = pose.rotation;
  }

  /** ホイールの分だけ、持っている物を前後に動かす（画面上の位置は保つ） */
  private reachHeld(id: EntityId, ev: InputEvent, deltaMeters: number): void {
    const held = this.world.get(id, BUILTIN.Grabbable);
    if (!held) return;
    held.offset = moveAlongView((held.offset as Vec3 | undefined) ?? [0, 0, 0], deltaMeters);
    this.placeHeld(id, ev);
  }

  /** マウスの動き（ラジアン）だけ、持っている物を回す */
  private twistHeld(id: EntityId, ev: InputEvent): void {
    const held = this.world.get(id, BUILTIN.Grabbable);
    const [yaw, pitch] = ev.pointer ?? [0, 0];
    if (!held || (yaw === 0 && pitch === 0)) return;
    const t = this.worldPose(id);
    this.writeWorldPose(id, t.position, twistRotation(t.rotation, yaw, pitch));
    const pose = this.poseInView(id, ev);
    held.rotation = pose.rotation;
  }

  /** 配置の Entity を World に作る（ID の付け替え、動作上の親に配置の位置・向き） */
  private instantiate(part: Part): void {
    const { world, names } = buildWorld(
      part.snapshot,
      part.outputId,
      buildRegistry([
        ...part.snapshot.kokostates,
        ...packageKokoStates(reachablePackages(part.snapshot.dependencies, part.packages)),
      ]),
    );
    const snap = world.snapshot();
    // アイテムとワールドの座標の親。配置の位置と向きはここだけに置く（ADR 0057）
    const rootId = this.eid(part, SPACE_ROOT_ID);
    if (this.world.has(rootId)) this.world.destroy(rootId);
    this.world.spawn(rootId, null);
    this.world.add(rootId, BUILTIN.Transform, {
      position: [part.position[0], part.position[1], part.position[2]],
      rotation: [0, (part.yaw * 180) / Math.PI, 0],
      scale: [1, 1, 1],
    });
    const outputName = part.snapshot.outputs.find((o) => o.id === part.outputId)?.name;
    this.names.set(rootId, outputName || part.outputId);
    part.entities.add(rootId);
    for (const e of snap.entities) {
      const id = this.eid(part, e.id);
      // 予約した ID は、動作上の親に使う
      if (id === rootId) continue;
      if (this.world.has(id)) this.world.destroy(id);
      this.world.spawn(id, e.parent === null ? rootId : this.eid(part, e.parent));
      for (const [koko, values] of Object.entries(e.states)) {
        const k = this.kid(part.realm, koko);
        if (!this.registry.get(k)) continue;
        const v = { ...values };
        if (koko === BUILTIN.Mesh && typeof v.material === "string")
          v.material = this.mid(part.realm, v.material);
        for (const f of this.registry.require(k).fields) {
          const schema = this.schemaOf(k, f);
          if (!schema || !Object.hasOwn(v, f.id)) continue;
          // 型の定義を変えたあとの値は、型に合わせてから使う（足りないフィールドを埋め、型にないものを捨てる）
          if (validateValue(schema, v[f.id]) !== null)
            v[f.id] = conformValue(schema, v[f.id]) as FieldValue;
          // Entity の参照（入れ子の中も）を、この配置の中の ID に付け替える
          if (!hasRefs(schema)) continue;
          v[f.id] = mapRefs(schema, v[f.id], (target, ref) =>
            target === "entity" ? this.eid(part, ref) : undefined,
          ) as FieldValue;
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
    // ライブラリの VM は、その版の System がなくなったら破棄する
    if (isLibraryVm(sys.realm) && !this.systems.some((s) => s.realm === sys.realm))
      this.sandbox.disposeRealm(sys.realm);
  }

  /**
   * アウトプットの System の中身と、読み込む場所。ライブラリの System（`pkg:` の ID）は、
   * 依存の中身から取り出し、ライブラリの中の論理パスで import を解決する（公開したものだけが見える）。
   * 使えないときは、その理由。
   */
  private systemSource(
    part: Part,
    refId: string,
    packages: Map<string, PackageResolution>,
    ownIndex: () => ResourcePathIndex,
  ):
    | {
        ok: true;
        def: { id: string; name: string; code: string };
        realm: string;
        index: () => ResourcePathIndex;
        packages?: Map<string, PackageResolution>;
      }
    | { ok: false; name: string; error: string }
    | null {
    const ref = parsePackageResourceId(refId);
    if (!ref) {
      const def = part.snapshot.systems.find((s) => s.id === refId);
      return def ? { ok: true, def, realm: part.realm, index: ownIndex, packages } : null;
    }
    const resolution = [
      ...packages.values(),
      ...reachablePackages(part.snapshot.dependencies, part.packages),
    ].find((r) => r.dependency.packageId === ref.packageId && r.dependency.version === ref.version);
    if (!resolution)
      return { ok: false, name: refId, error: "このライブラリの版は、今の依存にありません" };
    const alias = resolution.dependency.alias;
    if (resolution.status !== "ready")
      return {
        ok: false,
        name: `@${alias}`,
        error: `ライブラリ「@${alias}」を使えません：${resolution.message}`,
      };
    const lib = librarySnapshot(resolution);
    const def = lib.systems.find((s) => s.id === refId);
    if (!def)
      return {
        ok: false,
        name: `@${alias}`,
        error: `ライブラリ「@${alias}」（v${ref.version}）に、この System は公開されていません`,
      };
    let index: ResourcePathIndex | null = null;
    return {
      ok: true,
      def: { ...def, name: `@${alias}/${def.name}` },
      realm: libraryVm(part.realm, ref.packageId, ref.version),
      index: () => {
        index ??= ResourcePathIndex.fromSnapshot(lib);
        return index;
      },
      // ライブラリの System の `@別名` は、そのライブラリの依存（依存の依存）で解決する
      packages: resolutionMap(resolution.manifest.dependencies, part.packages),
    };
  }

  private loadSystems(part: Part, reloaded?: Set<string>): void {
    const output = part.snapshot.outputs.find((o) => o.id === part.outputId);
    if (!output) throw new Error(`Unknown output: ${part.outputId}`);
    let index: ResourcePathIndex | null = null;
    const ownIndex = () => {
      index ??= ResourcePathIndex.fromSnapshot(part.snapshot);
      return index;
    };
    const packages = resolutionMap(part.snapshot.dependencies, part.packages);
    for (const ref of output.systems) {
      const source = this.systemSource(part, ref.id, packages, ownIndex);
      if (!source) continue;
      const id = this.multi ? `${part.realm}:${ref.id}` : ref.id;
      const existing = this.systems.find((s) => s.id === id);
      if (existing && (!reloaded || reloaded.has(id))) {
        existing.users.add(part.id);
        continue;
      }
      const users = new Set(existing?.users);
      if (existing) this.dropSystem(existing);
      users.add(part.id);
      reloaded?.add(id);
      const def = source.ok ? source.def : { id: ref.id, name: source.name, code: "" };
      // ライブラリの System は自分の VM で動き、使う側の KokoState は見えない（Built-in と依存のものだけ）
      const realm = source.ok ? source.realm : part.realm;
      const sys: LoadedSystem = {
        id,
        realm,
        users,
        name: def.name,
        with: [],
        without: [],
        handlers: new Set(),
        enabled: ref.enabled,
        error: null,
        line: null,
        warnings: new Map(),
        capabilities: new Set(inferCapabilities(def.id, def.code).capabilities),
      };
      this.systems.push(sys);
      if (!ref.enabled) continue;
      try {
        if (!source.ok) throw new ScriptError(source.error, id, "load");
        // import した KokoState を安定 ID に結び付けた JS にしてから読み込む（ADR 0010）
        const compiled = compileSystem(def.id, def.code, source.index(), source.packages);
        const first = compiled.diagnostics[0];
        if (!compiled.ok && first)
          throw new ScriptError(
            first.message,
            id,
            "load",
            first.location?.kind === "script" ? first.location.line : null,
          );
        const instrumented = this.debug ? instrumentDebug(compiled.javascript, id) : null;
        if (instrumented) this.debug?.register(id, instrumented.lines);
        const meta = this.sandbox.loadSystem(
          id,
          instrumented?.javascript ?? compiled.javascript,
          realm,
        );
        const scope = this.scopeOfRealm(realm);
        const resolve = (refs: string[]) =>
          refs.map((n) => {
            const k = this.resolveKoko(n, realm);
            if (k) return k;
            if (this.registry.isAmbiguous(n, scope))
              throw new ScriptError(
                `Query の KokoState「${n}」は同じ名前が複数あります（import で読み込んでください）`,
                id,
                "load",
              );
            throw new ScriptError(`Query の KokoState「${n}」が見つかりません`, id, "load");
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

  /**
   * 実効権限の判定（ADR 0012）：その System の宣言（コードから読み取り）にあり、呼び出しの主体の配置すべてに
   * 付与されている Capability だけを許す。拒んだときは、その System に注意を残す。
   * 別の配置への届き方（World の上限・相手の公開範囲）は、それぞれの Host API の中で判定する。
   */
  private permits(name: HostName, ctx: HostCallContext, callers: Part[]): boolean {
    const cap = HOST_CAPABILITIES[name];
    const sys = this.systems.find((x) => x.id === ctx.systemId);
    const declared = cap !== undefined && sys?.capabilities.has(cap) === true;
    const granted = callers.every(
      (p) => cap !== undefined && (p.grants === undefined || p.grants.includes(cap)),
    );
    if (declared && granted) return true;
    this.warn(
      ctx.systemId,
      "capability-denied",
      `権限「${cap ?? name}」がないため、${name} は使えませんでした${declared ? "（置いた物に付与されていません）" : "（コードから読み取れない使い方です）"}`,
    );
    return false;
  }

  /** Entity が入っている配置 */
  private partOf(id: EntityId): Part | undefined {
    return [...this.parts.values()].find((p) => p.entities.has(id));
  }

  /** 別の配置からの見え方（ADR 0012。ないときは interactive） */
  private exposureOf(part: Part): OutputExposure {
    return part.snapshot.outputs.find((o) => o.id === part.outputId)?.exposure ?? "interactive";
  }

  /** セッションの土台の World（最初に置いた World の配置） */
  private baseWorld(): Part | undefined {
    return [...this.parts.values()].find(
      (p) => p.snapshot.outputs.find((o) => o.id === p.outputId)?.kind === "world",
    );
  }

  /**
   * 呼び出しの主体にかかる上限（ADR 0012）。主体がすべて「外から来た Item」（土台の World と別の作者の
   * Item）なら、土台の World の guestPolicy。それ以外は上限なし（interactive）。
   */
  private guestLimit(callers: Part[]): GuestPolicy {
    const base = this.baseWorld();
    if (!base || callers.length === 0) return "interactive";
    const guest = (p: Part) =>
      p.source !== base.source &&
      p.snapshot.outputs.find((o) => o.id === p.outputId)?.kind !== "world";
    if (!callers.every(guest)) return "interactive";
    return base.snapshot.outputs.find((o) => o.id === base.outputId)?.guestPolicy ?? "interactive";
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
  private callHost(name: HostName, rawArgs: Value[], ctx: HostCallContext): Value {
    const callers = this.callerParts(ctx);
    // セッションでは、実効権限（宣言 ∩ 置いた物への付与）に無い Capability を拒む（deny-by-default）
    if (this.multi && !this.permits(name, ctx, callers)) return DENIED_RESULT[name];
    const own = (id: string | undefined): id is EntityId =>
      typeof id === "string" && this.world.has(id) && callers.some((p) => p.entities.has(id));
    /** 参照が指す KokoState（実行時の ID）。自分の配置の Entity が、その KokoState を持っているときだけ */
    const stateOf = (ref: { entity: string; koko: string } | undefined) => {
      if (!ref || !own(ref.entity)) return undefined;
      const koko = this.resolveKoko(ref.koko, ctx.realm);
      return koko && this.world.hasState(ref.entity, koko) ? koko : undefined;
    };
    /** フィールドの参照が指すフィールドと、その値の入れ物 */
    const fieldOf = (ref: { entity: string; koko: string; field?: string } | undefined) => {
      const koko = stateOf(ref);
      const values = ref && koko ? this.world.get(ref.entity, koko) : undefined;
      const field = koko && this.registry.get(koko)?.fields.find((f) => f.id === ref?.field);
      return koko && values && field ? { koko, values, field } : undefined;
    };
    const api: { [N in HostName]: (args: HostArgs<N>) => Value } = {
      "world.raycast": ([origin, direction, max, opts]) => {
        // 非公開（private）の別の配置には当たらない（見つからない）。土台の World が外から来た Item に
        // 何も許さないときは、自分の配置の外はすべて見つからない
        const limit = this.guestLimit(callers);
        const hidden = [...this.parts.values()]
          .filter(
            (p) => !callers.includes(p) && (limit === "deny" || this.exposureOf(p) === "private"),
          )
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
          this.pending.push({ kind: "event", target, name, data: (data ?? null) as Value });
        return undefined;
      },
      "contract.send": ([token, name, payload]) => {
        if (!isContractName(name)) throw new TypeError(`Contract「${name}」はありません`);
        if (HOST_ONLY_CONTRACTS.includes(name))
          throw new TypeError(`${name} はプレイヤーの操作（E）でだけ送られます`);
        const data = parseContractPayload(name, payload) as Value;
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
        const allowed =
          targetPart &&
          this.exposureOf(targetPart) === "interactive" &&
          this.guestLimit(callers) === "interactive";
        if (!own(target) && !allowed) {
          // 相手は公開されている（当たっている）ので、拒まれたことを知らせてよい
          const message = `${name} は受け付けられませんでした（相手が受け付けていないか、World が許していません）`;
          this.log(ctx.systemId, message, "log");
          this.warn(ctx.systemId, "contract-denied", message);
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
        const koko = kokoName ? this.resolveKoko(kokoName, ctx.realm) : undefined;
        if (!koko || !own(id) || !this.world.hasState(id, koko)) return null;
        return this.toNamed(koko, this.world.get(id, koko) ?? {});
      },
      "world.set": ([id, kokoName, values]) => {
        const koko = kokoName ? this.resolveKoko(kokoName, ctx.realm) : undefined;
        if (!koko || !own(id) || !this.world.hasState(id, koko) || !values) return false;
        this.writeNamed(id, koko, values as Record<string, Value>, null);
        return true;
      },
      // 参照から読み書きする（ADR 0065）。world.get・world.set と同じく、自分の配置の Entity だけ
      "world.getState": ([ref]) => {
        const koko = stateOf(ref);
        return ref && koko ? this.toNamed(koko, this.world.get(ref.entity, koko) ?? {}) : undefined;
      },
      "world.setState": ([ref, values]) => {
        const koko = stateOf(ref);
        if (!ref || !koko || !values) return false;
        this.writeNamed(ref.entity, koko, values as Record<string, Value>, null);
        return true;
      },
      "world.getField": ([ref]) => {
        const at = fieldOf(ref);
        return at ? cloneValue(at.values[at.field.id]) : undefined;
      },
      "world.setField": ([ref, value]) => {
        const at = fieldOf(ref);
        if (!at || !this.accepts(at.koko, at.field, value as Value)) return false;
        at.values[at.field.id] = cloneValue(value) as FieldValue;
        return true;
      },
      "world.find": ([name]) => {
        for (const [id, n] of this.names) if (n === name && own(id) && !isSpaceRoot(id)) return id;
        return null;
      },
      "world.spawn": ([desc]) => {
        const space = callers[0] ? this.eid(callers[0], SPACE_ROOT_ID) : null;
        const parent = own(desc?.parent)
          ? desc.parent
          : space && this.world.has(space)
            ? space
            : null;
        const id = this.world.spawn(undefined, parent);
        this.names.set(id, desc?.name ?? id);
        // 作った Entity は、呼んだ System の配置のものにする
        callers[0]?.entities.add(id);
        for (const [kokoName, values] of Object.entries(desc?.states ?? {})) {
          const koko = this.resolveKoko(kokoName, ctx.realm);
          if (!koko) continue;
          this.world.add(id, koko);
          if (values && typeof values === "object" && !Array.isArray(values)) {
            this.writeNamed(id, koko, values as Record<string, Value>, null);
          }
        }
        return id;
      },
      "world.destroy": ([id]) => {
        // 動作上の親を消すと、中の Entity も一緒に消える
        if (own(id) && !isSpaceRoot(id)) this.world.destroy(id);
        return undefined;
      },
      "bag.add": ([type, values]) => {
        const bag = this.bagFor(ctx, type);
        if (!bag || bag.items.length >= BAG_LIMIT) return false;
        bag.items.push({
          type: bag.koko,
          name: bag.name,
          values: this.bagValues(bag.koko, values),
        });
        return true;
      },
      "bag.take": ([type, match]) => {
        const bag = this.bagFor(ctx, type);
        if (!bag) return null;
        const i = bag.items.findIndex(
          (it) =>
            it.type === bag.koko &&
            Object.entries(match ?? {}).every(([k, v]) => equalValues(it.values[k], v)),
        );
        if (i < 0) return null;
        const [taken] = bag.items.splice(i, 1);
        return taken ? structuredClone(taken.values) : null;
      },
      "bag.count": ([type]) => {
        const bag = this.bagFor(ctx, type);
        return bag ? bag.items.filter((it) => it.type === bag.koko).length : 0;
      },
      "bag.list": ([type]) => {
        const bag = this.bagFor(ctx, type);
        return bag
          ? bag.items.filter((it) => it.type === bag.koko).map((it) => structuredClone(it.values))
          : [];
      },
      "time.now": () => this.time,
      "audio.play": ([clip, entity, volume]) => {
        // clip：素材の名前か ID。null なら entity の AudioSource の clip を鳴らす
        const target = own(entity) ? entity : null;
        const source = target ? this.world.get(target, BUILTIN.AudioSource) : undefined;
        const assets = this.realmAssets.get(ctx.realm) ?? [];
        const ref = clip ?? (source?.clip as string | undefined);
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
    const call = api[name] as (args: unknown) => Value;
    return call(parseHostArgs(name, rawArgs));
  }

  private active(handler: string): LoadedSystem[] {
    return this.systems.filter((s) => s.enabled && s.handlers.has(handler));
  }

  private matches(sys: LoadedSystem): EntityId[] {
    return this.world
      .query({ with: sys.with, without: sys.without })
      .filter((id) => this.withinUsers(sys, id));
  }

  /**
   * System が処理してよい Entity か。セッションでは、その System を使う配置の Entity だけ
   * （ADR 0012 の既定の境界）。Built-in と依存の KokoState は realm をまたいで同じ ID なので、
   * Query だけでは別の配置の Entity まで当たってしまう。
   */
  private withinUsers(sys: LoadedSystem, id: EntityId): boolean {
    if (!this.multi) return true;
    for (const p of sys.users) if (this.parts.get(p)?.entities.has(id)) return true;
    return false;
  }

  private entityMatches(sys: LoadedSystem, id: EntityId): boolean {
    return (
      this.withinUsers(sys, id) &&
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

  private runSystem(sys: LoadedSystem, handler: string, ids: EntityId[], args: Value[]): void {
    if (ids.length === 0 || !sys.enabled) return;
    const before = ids.map((id) => this.toScriptEntity(id, sys));
    try {
      const after = this.sandbox.run(sys.id, handler, before, args, this.taggedFields(sys));
      after.forEach((e, i) => {
        const prev = before[i];
        if (!prev || e.id !== prev.id || !this.world.has(e.id)) return;
        for (const [key, values] of Object.entries(e.states)) {
          // キーは領域の中の ID（ADR 0010）。その Entity が持っている KokoState だけに書く
          const koko = isShared(key) ? key : this.kid(sys.realm, key);
          if (!this.world.hasState(e.id, koko) || !values || typeof values !== "object") continue;
          this.writeNamed(e.id, koko, values as Record<string, Value>, prev.states[key] ?? null);
        }
      });
    } catch (e) {
      this.fail(sys, e);
      if (this.sandbox.broken) this.dispose();
    }
  }

  private async runSystemDebug(
    sys: LoadedSystem,
    handler: string,
    ids: EntityId[],
    args: Value[],
  ): Promise<void> {
    if (ids.length === 0 || !sys.enabled || this.disposed) return;
    const before = ids.map((id) => this.toScriptEntity(id, sys));
    const apply = (after: ScriptEntity[]) => {
      after.forEach((e, i) => {
        const prev = before[i];
        if (!prev || e.id !== prev.id || !this.world.has(e.id)) return;
        for (const [key, values] of Object.entries(e.states)) {
          const koko = isShared(key) ? key : this.kid(sys.realm, key);
          if (!this.world.hasState(e.id, koko) || !values || typeof values !== "object") continue;
          this.writeNamed(e.id, koko, values, prev.states[key] ?? null);
        }
      });
    };
    this.activeDebugApply = apply;
    try {
      const after = await this.sandbox.runAsync(sys.id, handler, before, args);
      if (!this.disposed) apply(after);
    } catch (e) {
      if (!this.disposed) this.fail(sys, e);
      if (this.sandbox.broken) this.dispose();
    } finally {
      this.activeDebugApply = null;
    }
  }

  private debugStates(entity: string | null): DebugKokoState[] {
    if (!entity || !this.world.has(entity)) return [];
    return this.registry.all().flatMap((koko) => {
      const values = this.world.get(entity, koko.id);
      return values
        ? [
            {
              id: koko.id,
              name: koko.name,
              fields: koko.fields.map((field) => ({
                id: field.id,
                name: field.name,
                value: encodeValue(values[field.id]),
              })),
            },
          ]
        : [];
    });
  }

  private writeDebugState(edit: DebugStateEdit): boolean {
    if (!this.world.has(edit.entity)) return false;
    const values = this.world.get(edit.entity, edit.koko);
    const field = this.registry.get(edit.koko)?.fields.find((f) => f.id === edit.field);
    const value = decodeValue(edit.value) as Value;
    if (!values || !field || !this.accepts(edit.koko, field, value)) return false;
    values[field.id] = cloneValue(value) as FieldValue;
    // VM はフィールド名で保持する。返り値用の操作も、その名前へそろえる。
    edit.fieldName = field.name;
    return true;
  }

  /**
   * スクリプトに渡す Entity。状態は領域の中の KokoState ID をキーにする。渡すのは、その System の
   * Query の with に書いた KokoState だけ（e.get() で触れられるのもそれだけ。ADR 0058）。
   * 別の領域の KokoState は見せない（ADR 0012）。
   */
  private toScriptEntity(id: EntityId, sys: LoadedSystem): ScriptEntity {
    const states: ScriptEntity["states"] = {};
    const scope = this.scopeOfRealm(sys.realm);
    for (const koko of sys.with) {
      if (!this.world.hasState(id, koko) || !this.registry.get(koko)) continue;
      if (this.multi && !isShared(koko) && this.registry.scopeOf(koko) !== scope) continue;
      states[this.localKey(koko, sys.realm)] = this.toNamed(koko, this.world.get(id, koko) ?? {});
    }
    return { id, states };
  }

  /**
   * JSON で表せない値を持ちうるフィールド（スクリプトとの間を、値の形式で運ぶもの）。
   * スキーマから決める：JSON で表せる値しか持たない型（有限の数・文字・真偽・色・必ず指す参照と、
   * その並びやレコード）のフィールドは入れない。スキーマが分からないフィールドは入れる。
   */
  private taggedFields(sys: LoadedSystem): TaggedFields {
    const out: Record<string, string[]> = {};
    for (const koko of sys.with) {
      const names = (this.registry.get(koko)?.fields ?? [])
        .filter((f) => {
          const schema = this.schemaOf(koko, f);
          return !schema || !isJsonSafe(schema, isBuiltin(koko));
        })
        .map((f) => f.name);
      if (names.length > 0) out[this.localKey(koko, sys.realm)] = names;
    }
    return out;
  }

  private toNamed(koko: KokoStateId, values: Record<string, FieldValue>): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const f of this.registry.require(koko).fields) out[f.name] = cloneValue(values[f.id]);
    return out;
  }

  /** スクリプトが書いた値（フィールド名）を World（フィールド ID）へ書く。変わったフィールドだけ・型が合うものだけ。 */
  private writeNamed(
    id: EntityId,
    koko: KokoStateId,
    values: Record<string, Value>,
    before: Record<string, Value> | null,
  ): void {
    const target = this.world.get(id, koko);
    if (!target) return;
    for (const f of this.registry.require(koko).fields) {
      if (!(f.name in values)) continue;
      const v = values[f.name];
      if (before && equalValues(before[f.name], v)) continue;
      if (this.accepts(koko, f, v)) target[f.id] = cloneValue(v) as FieldValue;
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
