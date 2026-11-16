import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import {
  decodeValue,
  encodeValue,
  hasTag,
  type Json,
  parseValue,
  stringifyValue,
  VALUE_CODEC_SOURCE,
  type Value,
} from "@tukurium/eks";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSAsyncContext,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import { DEBUG_PRELUDE, type DebugEdit, type DebugPoint, type DebugRunConfig } from "./debug";

/** スクリプトから見える Entity。KokoState の ID → フィールド名 → 値。 */
export interface ScriptEntity {
  id: string;
  /** KokoState の ID（その領域の中の ID）→ フィールド名 → 値 */
  states: Record<string, Record<string, Value>>;
}

/** スクリプトが宣言した System の情報（Query は import した KokoState の ID。ADR 0058） */
export interface SystemMeta {
  query: { with: string[]; without: string[] };
  handlers: string[];
}

/** ホスト関数を呼んだ System。権限や所有者の判定に使う。 */
export interface HostCallContext {
  realm: string;
  systemId: string | null;
  /** 呼び出したときに処理していた Entity（ハンドラの外なら null） */
  entity?: string | null;
}

/** スクリプトから呼べるホスト関数。名前は "world.raycast" のように「名前空間.関数名」。 */
export type HostFunction = (args: Value[], ctx: HostCallContext) => Value;

export interface SandboxOptions {
  debug?: {
    onPoint(point: DebugPoint): Promise<DebugEdit[]>;
    /** 呼び出しの前に VM へ渡す、止まるかもしれない所。 */
    config?(systemId: string): DebugRunConfig;
    /** ステップ実行の途中か。途中なら、すべての文をホストへ渡す。 */
    stepping?(): boolean;
    /** Host API が見張っているフィールドを変え、まだ確かめていないか。 */
    pending?(): boolean;
    /** この呼び出しで、一時停止できる所を通った。 */
    seen?(): void;
  };
  /** ハンドラ 1 回の呼び出しで使える時間。超えたら中断する。 */
  timeLimitMs?: number;
  /** 読み込み（領域の準備・スクリプトの評価）で使える時間。初回は VM の準備が入るので長めにする。 */
  loadTimeLimitMs?: number;
  /** VM 全体のメモリ上限。 */
  memoryLimitBytes?: number;
  hostFunctions?: Record<string, HostFunction>;
  /**
   * Entity の値を読み書きするホスト関数の名前。これを呼ぶ直前に、スクリプトが持っている値をホストと合わせる
   * （`run()` の sync。ADR 0082）。渡さなければ、すべてのホスト関数の前で合わせる。
   */
  syncHostFunctions?: string[];
  onLog?: (message: string, ctx: HostCallContext) => void;
}

/**
 * JSON で表せない値（undefined・Date・Map など）を持ちうるフィールド。KokoState の ID（ScriptEntity の
 * states のキー）→ フィールド名。`run()` に渡すと、ここに書いたフィールドだけを値の形式で読み書きし、
 * ほかのフィールドは QuickJS の JSON.parse / JSON.stringify に任せる（全 Entity の値を毎回たどらずに済む）。
 */
export type TaggedFields = Record<string, readonly string[]>;

/**
 * 呼び出しの途中で、ホストの World と値を合わせる口（ADR 0082）。
 * - push：Host API を呼ぶ直前に、スクリプトが持っている値が届く。World へ書く。
 * - pull：Host API のあとに呼ぶ。その間にホストが変えた Entity の、変わったフィールドの値を返す（なければ undefined）。
 */
export interface RunSync {
  push(entities: ScriptEntity[]): void;
  pull(): ScriptEntity[] | undefined;
}

export class ScriptError extends Error {
  constructor(
    message: string,
    readonly systemId: string | null,
    readonly kind: "load" | "runtime" | "timeout" | "memory",
    /** スクリプトの何行目か（分かるときだけ。1 始まり） */
    readonly line: number | null = null,
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

/** 書き出した形の ScriptEntity */
interface StoredEntity {
  id: string;
  states: Record<string, Record<string, Json>>;
}

/**
 * QuickJS の側で値の形式を通すフィールド。
 * - read：渡す値にタグがあるフィールド（値に戻す）
 * - write：read と、呼び出す側が指定したフィールド（スクリプトが JSON で表せない値を書きうる）
 */
function fieldsToFix(
  entities: StoredEntity[],
  tagged: TaggedFields,
): { read: Record<string, string[]>; write: Record<string, string[]> } {
  const read = new Map<string, Set<string>>();
  for (const e of entities) {
    for (const [koko, values] of Object.entries(e.states)) {
      for (const [name, value] of Object.entries(values)) {
        if (value === null || typeof value !== "object" || !hasTag(value)) continue;
        const names = read.get(koko) ?? new Set<string>();
        names.add(name);
        read.set(koko, names);
      }
    }
  }
  const write = new Map([...read].map(([koko, names]) => [koko, new Set(names)]));
  for (const [koko, list] of Object.entries(tagged)) {
    const names = write.get(koko) ?? new Set<string>();
    for (const name of list) names.add(name);
    write.set(koko, names);
  }
  const plain = (m: Map<string, Set<string>>) =>
    Object.fromEntries([...m].map(([koko, names]) => [koko, [...names]]));
  return { read: plain(read), write: plain(write) };
}

/** QuickJS が書き出した Entity の値を読む */
function readEntities(out: string, fix: ReturnType<typeof fieldsToFix> | null): ScriptEntity[] {
  if (!fix) return parseValue(out) as ScriptEntity[];
  // 値の形式で返ってくるのは、指定したフィールドだけ。ほかのフィールドは、"$t" を持つオブジェクトを
  // 書かれても、タグとして読まない（ふつうのオブジェクトのまま返す）
  const result = JSON.parse(out) as StoredEntity[];
  for (const e of result) {
    for (const [koko, names] of Object.entries(fix.write)) {
      const values = e?.states?.[koko];
      if (values === null || typeof values !== "object") continue;
      for (const name of names)
        if (Object.hasOwn(values, name)) values[name] = decodeValue(values[name]) as Json;
    }
  }
  return result as unknown as ScriptEntity[];
}

/** QuickJS のスタックから、その System のファイルの行番号を取り出す */
export function lineInStack(stack: string | undefined, systemId: string | null): number | null {
  if (!stack || !systemId) return null;
  const esc = systemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`/${esc}\\.js:(\\d+)`).exec(stack);
  return m ? Number(m[1]) : null;
}

const PRELUDE = (hostNames: string[], syncNames: string[], debug = false) => `
"use strict";
// 値の書き出しと読み込み（ホストと同じ関数。ADR 0065）。undefined・Date・Map・Set・bigint・NaN も、
// ホストとの間をそのまま行き来できる
const __codec = (${VALUE_CODEC_SOURCE})();
const __write = (v) => JSON.stringify(__codec.encode(v));
const __read = (text) => __codec.decode(JSON.parse(text));
// Host API の引数と戻り値は、よく通る道を軽くする。値の形式のタグ（"$t" のキー）がなければ、ふつうの JSON と同じ
const __readFast = (text) => text.indexOf('"$t"') === -1 ? JSON.parse(text) : __codec.decode(JSON.parse(text));
const __writeArgs = (args) => {
  for (let i = 0; i < args.length; i++) {
    const v = args[i];
    const t = typeof v;
    if (t === "string" || t === "boolean" || v === null || (t === "number" && v - v === 0)) continue;
    return __write(args);
  }
  return JSON.stringify(args);
};
// Entity の値のうち、fields（KokoState の ID → フィールド名）に書いたフィールドだけを、値の形式から戻す
// （encode が false）・値の形式に書き出す（true）。全 Entity の分を毎回通るので、よく通る道を軽くしてある
const __eachField = (entities, fields, encode) => {
  const kokos = Object.keys(fields);
  for (let i = 0; i < entities.length; i++) {
    const states = entities[i].states;
    for (let j = 0; j < kokos.length; j++) {
      const values = states[kokos[j]];
      if (values === null || typeof values !== "object") continue;
      const names = fields[kokos[j]];
      for (let k = 0; k < names.length; k++) {
        const name = names[k];
        const v = values[name];
        if (encode) {
          // 有限の数・文字・真偽は、そのままで JSON になる（v - v は、NaN と Infinity では 0 にならない）
          const t = typeof v;
          if (t === "string" || t === "boolean" || (t === "number" && v - v === 0)) continue;
          // 消したフィールド（キーがない）は、そのままにする。undefined を入れたフィールドは運ぶ
          if (v === undefined && !(name in values)) continue;
          values[name] = __codec.encode(v);
        } else if (v !== null && typeof v === "object") {
          // タグは、いつもオブジェクト。数・文字などは、そのままで値になっている
          values[name] = __codec.decode(v);
        }
      }
    }
  }
};
// JSON にする。ほかのフィールドに bigint を入れると JSON.stringify が投げるので、型が合わない値として null にする
// （ホストが受け入れない）。輪になった値などは、もう一度投げてスクリプトのエラーにする
const __stringify = (v) => {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return JSON.stringify(v, function (key, x) { return typeof x === "bigint" ? null : x; });
  }
};
// 呼び出しの途中で、ホストの World と値を合わせる（ADR 0082）。合わせるのは、Entity の値を読み書きする
// Host API を呼ぶ直前と、呼び出しの終わり。
// { entities, fields, kokos, from（前に合わせた Entity の順番）, i（いまの順番）, got, last（最後に送った文字）, index }
let __sync = null;
// 送る Entity の値を文字にする。値の形式を通すフィールドだけを写して書き出す（持っている値は書き換えない）
// kokos は、値の形式を通すフィールドを持つ KokoState（なければ、そのまま JSON にできる）
const __pack = (e, fields, kokos) => {
  if (!fields) return __write(e.states);
  if (kokos.length === 0) return __stringify(e.states);
  const states = Object.assign({}, e.states);
  for (let j = 0; j < kokos.length; j++) {
    const v = states[kokos[j]];
    if (v !== null && typeof v === "object") states[kokos[j]] = Object.assign({}, v);
  }
  const copy = { id: e.id, states };
  __eachField([copy], fields.write, true);
  return __stringify(states);
};
// Host API を呼ぶ直前に送る値：前に合わせてから回した Entity と、いまの Entity のうち、前に送ってから
// 変わったもの。ホストとの境目をまたぐのは重いので、変わったかどうかは、ここで文字を比べて決める
const __flush = () => {
  const s = __sync;
  if (s === null || (s.from === s.i && !s.got)) return undefined;
  let out = "";
  for (let k = s.from; k <= s.i; k++) {
    const text = __pack(s.entities[k], s.fields, s.kokos);
    if (s.last[k] === text) continue;
    s.last[k] = text;
    out += (out === "" ? "[" : ",") + '{"id":' + JSON.stringify(s.entities[k].id) + ',"states":' + text + "}";
  }
  s.from = s.i;
  s.got = false;
  return out === "" ? undefined : out + "]";
};
// Host API の間にホストが変えた値を、持っている値のオブジェクトへ書き戻す（同じオブジェクトを書き換えるので、
// const g = e.get(Gun) で持っている値にも届く）。text は「変わった Entity」\u0001「戻り値」
const __pull = (text) => {
  const cut = text.indexOf("\u0001");
  const s = __sync;
  if (s !== null) {
    const changed = s.fields ? JSON.parse(text.slice(0, cut)) : __read(text.slice(0, cut));
    if (s.fields && s.kokos.length > 0) __eachField(changed, s.fields.write, false);
    if (s.index === null) {
      s.index = new Map();
      for (let k = 0; k < s.entities.length; k++) s.index.set(s.entities[k].id, k);
    }
    for (const c of changed) {
      const k = s.index.get(c.id);
      if (k === undefined) continue;
      const e = s.entities[k];
      // 届くのは、変わったフィールドだけ。ほかのフィールドは、スクリプトが持っている値のまま
      for (const koko of Object.keys(c.states)) {
        const cur = e.states[koko];
        if (cur === null || typeof cur !== "object") e.states[koko] = c.states[koko];
        else Object.assign(cur, c.states[koko]);
      }
      // 前に送った文字とは合わなくなったので、次に合わせるときに送り直す（ホストは、同じ値なら何もしない）
      s.last[k] = undefined;
    }
  }
  const r = text.slice(cut + 1);
  return r === "" ? undefined : __readFast(r);
};
const __systems = Object.create(null);
let __current = null;
// いま処理している Entity（Host API の呼び出しが、どの配置のためのものかを決める。ADR 0012）
let __entity = null;
globalThis.system = (def) => {
  if (def === null || typeof def !== "object") throw new TypeError("system() には設定オブジェクトを渡してください");
  return def;
};
// import した KokoState（コンパイラが const X = __koko(ID, 名前) に書き換える。ADR 0010）
// 文字列としては ID になる（world.get(id, X) などで ID として届く）
globalThis.__koko = (id, name) => Object.freeze({
  id, name,
  toString() { return id; },
  toJSON() { return id; },
});
const __isKoko = (k) => k !== null && typeof k === "object" && typeof k.id === "string" && typeof k.name === "string";
// System ごとの、e.get() で触れてよい KokoState（Query の with に書いたもの。ADR 0058）
const __allowed = {};
globalThis.log = (...args) => __log(__current, args.map((a) => typeof a === "string" ? a : a === undefined ? "undefined" : __write(a)).join(" "));
globalThis.console = { log: globalThis.log, warn: globalThis.log, error: globalThis.log };
const __ns = {};
const __syncNames = new Set(${JSON.stringify(syncNames)});
for (const full of ${JSON.stringify(hostNames)}) {
  const [ns, fn] = full.split(".");
  const syncs = __syncNames.has(full);
  (__ns[ns] ??= {})[fn] = (...args) => {
    const r = __hostCall(full, __writeArgs(args), __current, __entity, syncs ? __flush() : undefined);
    if (r === undefined) return undefined;
    // 先頭が \u0001 なら、ホストが変えた値が付いている
    return r.charCodeAt(0) === 1 ? __pull(r.slice(1)) : __readFast(r);
  };
}
// Raycast の結果に hit.send(Contract名, payload) を付ける（ADR 0012）。token は閉じ込めた値を使い、
// 結果の token を書き換えても、別の handle にはならない
if (__ns.world && __ns.world.raycast && __ns.contract && __ns.contract.send) {
  const raw = __ns.world.raycast;
  const send = __ns.contract.send;
  const effect = __ns.effects && __ns.effects.spawn;
  __ns.world.raycast = (...a) => {
    const hit = raw(...a);
    if (hit && typeof hit.token === "string") {
      const token = hit.token;
      Object.defineProperty(hit, "send", { value: (name, payload) => send(token, name, payload), enumerable: false });
      // hit.effect(種類, { color, size, life })：当たった点に一時的な effect を出す
      if (effect) Object.defineProperty(hit, "effect", { value: (kind, opts) => effect(token, kind, opts), enumerable: false });
    }
    return hit;
  };
}
for (const [ns, obj] of Object.entries(__ns)) globalThis[ns] = Object.freeze(obj);

globalThis.__define = (id, def) => {
  const q = def.query ?? {};
  // Query には import した KokoState だけを書く。名前の文字列は使えない（ADR 0058）
  const asList = (v, key) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new TypeError("query." + key + " には、import した KokoState の配列を書きます");
    return v.map((k) => {
      if (__isKoko(k)) return k.id;
      throw new TypeError("query." + key + " には、import した KokoState を書きます（" + JSON.stringify(k) + " のような名前の文字列は使えません。import Gun from './Gun.koko' のように読み込んでください）");
    });
  };
  const handlers = Object.keys(def).filter((k) => k.startsWith("on") && typeof def[k] === "function");
  // 公開 Contract：contracts: { Damage(e, payload) {...} }（ADR 0012）
  const contracts = def.contracts !== null && typeof def.contracts === "object" ? def.contracts : {};
  for (const k of Object.keys(contracts)) if (typeof contracts[k] === "function") handlers.push("contract:" + k);
  const withIds = asList(q.with, "with");
  const withoutIds = asList(q.without, "without");
  __systems[id] = def;
  __allowed[id] = new Set(withIds);
  return JSON.stringify({ query: { with: withIds, without: withoutIds }, handlers });
};
globalThis.__undefine = (id) => { delete __systems[id]; delete __allowed[id]; };
// fieldsJson：JSON で表せない値を持ちうるフィールド（{ read: {...}, write: {...} }）。空なら、全体を値の形式で
// 読み書きする（どんな値でも運べるが、全 Entity の値をたどるので遅い）
// syncOn が "1" なら、Host API の境目でホストと値を合わせる
globalThis.__run = (id, handler, entitiesJson, fieldsJson, argsJson, syncOn) => {
  const def = __systems[id];
  const fn = def && (handler.startsWith("contract:")
    ? (def.contracts && def.contracts[handler.slice("contract:".length)])
    : def[handler]);
  if (typeof fn !== "function") return entitiesJson;
  const fields = fieldsJson === "" ? null : JSON.parse(fieldsJson);
  const entities = fields ? JSON.parse(entitiesJson) : __read(entitiesJson);
  if (fields) __eachField(entities, fields.read, false);
  const args = __read(argsJson);
  ${debug ? "__debugBridge.reset(); __debugEntities = entities; __debugActive = true; __debugBridge.begin();" : ""}
  __current = id;
  const sync = syncOn === "1" ? { entities, fields, kokos: fields ? Object.keys(fields.write) : [], from: 0, i: 0, got: false, last: [], index: null } : null;
  __sync = sync;
  try {
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (sync !== null) sync.i = i;
      __entity = e.id;
      const st = e.states;
      const allowed = __allowed[id] ?? new Set();
      const view = { id: e.id };
      // e.get(Gun)：import した KokoState で、その値を取る。触れられるのは Query の with に書いたものだけ（ADR 0058）
      Object.defineProperty(view, "get", {
        value: (k) => {
          if (!__isKoko(k)) throw new TypeError("e.get() には、import した KokoState を渡します");
          if (!allowed.has(k.id)) throw new Error("「" + k.name + "」はこの System の query.with にないので、e.get() では使えません");
          if (sync !== null) sync.got = true;
          return st[k.id];
        },
        enumerable: false,
      });
      fn.call(handler.startsWith("contract:") ? def.contracts : def, view, ...args);
    }
  } finally {
    ${debug ? "__debugActive = false; __debugEntities = [];" : ""}
    __current = null;
    __entity = null;
    __sync = null;
  }
  if (!fields) return __write(entities);
  __eachField(entities, fields.write, true);
  return __stringify(entities);
};
`;

/**
 * 利用者の System スクリプトを、ページとは別の QuickJS VM で動かす。
 * - DOM・ネットワーク・ページのグローバルには触れられない。
 * - System は「領域（realm）」ごとに別の QuickJSContext に読み込む。別のリポジトリ（作者）の
 *   System は別の領域にすることで、`Object.prototype` やグローバルの書き換えが互いに届かない。
 *   同じ領域の System どうしはグローバルを共有する。
 * - 呼び出しごとに時間制限、VM 全体にメモリ制限をかける。
 *   QuickJS のメモリ上限は配列要素の確保を数えないため、サンドボックスごとに専用の WASM
 *   インスタンスを持ち、割り込みハンドラでヒープの大きさも監視する。WASM のヒープは縮まないので、
 *   メモリ超過で止まったサンドボックスは `broken` になり、作り直す必要がある。
 * - Entity の値は呼び出しごとに、タグ付きの JSON（ADR 0065）でまとめて受け渡す（境界をまたぐ回数を減らす）。
 */
export class ScriptSandbox {
  /** メモリ超過で止まった。以後の呼び出しは失敗するので作り直すこと。 */
  broken = false;
  private heapLimit = Number.POSITIVE_INFINITY;
  private overMemory = false;
  private currentLimit = 0;
  private readonly realms = new Map<string, QuickJSContext>();
  private readonly systemRealm = new Map<string, string>();
  private busy = false;
  private disposeRequested = false;
  private cancelWait: (() => void) | null = null;
  private debugDeadline = Number.POSITIVE_INFINITY;
  /** 時計を止めている間の、残りの実行時間。止めていなければ null。 */
  private debugRemaining: number | null = null;
  /** いまの呼び出しで、値を合わせる口と、値の形式を通すフィールド */
  private activeSync: { sync: RunSync; fix: ReturnType<typeof fieldsToFix> | null } | null = null;
  setDebugWatching(enabled: boolean): void {
    if (!this.host.debug || this.busy || this.disposeRequested) return;
    for (const vm of this.realms.values())
      this.unwrap(vm, vm.evalCode(`__setDebugWatching(${enabled})`), null, "runtime").dispose();
  }

  private constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly runtime: QuickJSRuntime,
    private readonly options: Required<
      Omit<SandboxOptions, "hostFunctions" | "syncHostFunctions" | "onLog" | "debug">
    >,
    private readonly host: Pick<
      SandboxOptions,
      "hostFunctions" | "syncHostFunctions" | "onLog" | "debug"
    >,
  ) {}

  static async create(options: SandboxOptions = {}): Promise<ScriptSandbox> {
    // リリース版の同期ビルドだけを使う（デバッグ版などを配信物に含めない）
    const QuickJS = options.debug
      ? await (await import("./debugModule")).createDebugModule()
      : await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
    const runtime = QuickJS.newRuntime();
    const opts = {
      timeLimitMs: options.timeLimitMs ?? 20,
      loadTimeLimitMs: options.loadTimeLimitMs ?? 1000,
      memoryLimitBytes: options.memoryLimitBytes ?? 32 * 1024 * 1024,
    };
    runtime.setMemoryLimit(opts.memoryLimitBytes);
    runtime.setMaxStackSize(512 * 1024);
    const sandbox = new ScriptSandbox(QuickJS.getWasmMemory(), runtime, opts, {
      hostFunctions: options.hostFunctions,
      syncHostFunctions: options.syncHostFunctions,
      onLog: options.onLog,
      debug: options.debug,
    });
    sandbox.heapLimit = sandbox.memory.buffer.byteLength + opts.memoryLimitBytes;
    return sandbox;
  }

  /**
   * System スクリプト（`export default system({...})`）を指定の領域に読み込む。
   * 同じ ID は置き換える（別の領域へ移す場合も、元の領域からは取り除く）。
   */
  loadSystem(id: string, source: string, realm = "default"): SystemMeta {
    if (this.busy) throw new Error("実行中のスクリプトは読み込み直せません");
    const prev = this.systemRealm.get(id);
    if (prev !== undefined && prev !== realm) this.unloadSystem(id);
    const vm = this.realm(realm);
    return this.withDeadline(this.options.loadTimeLimitMs, () => {
      const exportsHandle = this.unwrap(
        vm,
        vm.evalCode(source, `${realm}/${id}.js`, { type: "module", strict: true }),
        id,
        "load",
      );
      try {
        const def = vm.getProp(exportsHandle, "default");
        try {
          if (vm.typeof(def) !== "object") {
            throw new ScriptError("export default system({...}) が見つかりません", id, "load");
          }
          const meta = this.callGlobal(vm, "__define", [vm.newString(id), def], id, "load");
          this.systemRealm.set(id, realm);
          return JSON.parse(meta) as SystemMeta;
        } finally {
          if (def.alive) def.dispose();
        }
      } finally {
        exportsHandle.dispose();
      }
    });
  }

  unloadSystem(id: string): void {
    if (this.busy) throw new Error("実行中のスクリプトは取り除けません");
    const realm = this.systemRealm.get(id);
    if (realm === undefined) return;
    const vm = this.realms.get(realm);
    this.systemRealm.delete(id);
    if (vm)
      this.withDeadline(this.options.timeLimitMs, () =>
        this.callGlobal(vm, "__undefine", [vm.newString(id)], id, "runtime"),
      );
  }

  /** 領域ごと破棄する（その領域の System もすべて取り除く）。 */
  disposeRealm(realm: string): void {
    if (this.busy) throw new Error("実行中の領域は取り除けません");
    const vm = this.realms.get(realm);
    if (!vm) return;
    for (const [id, r] of [...this.systemRealm]) if (r === realm) this.systemRealm.delete(id);
    this.realms.delete(realm);
    this.disposeVm(vm);
  }

  /**
   * ハンドラ（onUpdate など）を Entity ごとに呼び、変更後の値を返す。
   *
   * taggedFields を渡すと、そこに書いたフィールド（と、渡した値にタグが要ったフィールド）だけを値の形式で
   * 読み書きする。それ以外のフィールドにスクリプトが JSON で表せない値を書いたときは、JSON.stringify の
   * とおりになる（undefined は書かなかったのと同じ、NaN・bigint は null、Date は文字）。型が合わない値として、
   * 呼び出す側が受け入れなければよい。渡さなければ、すべてのフィールドを値の形式で運ぶ。
   */
  run(
    id: string,
    handler: string,
    entities: ScriptEntity[],
    args: Value[] = [],
    taggedFields?: TaggedFields,
    sync?: RunSync,
  ): ScriptEntity[] {
    if (this.host.debug) throw new Error("デバッグ実行には runAsync を使います");
    const realm = this.systemRealm.get(id);
    const vm = realm === undefined ? undefined : this.realms.get(realm);
    if (!vm) throw new ScriptError(`System が読み込まれていません: ${id}`, id, "runtime");
    const json = encodeValue(entities) as unknown as StoredEntity[];
    const fix = taggedFields ? fieldsToFix(json, taggedFields) : null;
    const previous = this.activeSync;
    this.activeSync = sync ? { sync, fix } : null;
    try {
      return this.withDeadline(this.options.timeLimitMs, () => {
        const out = this.callGlobal(
          vm,
          "__run",
          [
            vm.newString(id),
            vm.newString(handler),
            vm.newString(JSON.stringify(json)),
            vm.newString(fix ? JSON.stringify(fix) : ""),
            vm.newString(stringifyValue(args)),
            vm.newString(sync ? "1" : ""),
          ],
          id,
          "runtime",
        );
        return readEntities(out, fix);
      });
    } finally {
      this.activeSync = previous;
    }
  }

  dispose(): void {
    if (this.busy) {
      this.disposeRequested = true;
      this.cancelWait?.();
      return;
    }
    for (const vm of this.realms.values()) this.disposeVm(vm);
    this.realms.clear();
    this.systemRealm.clear();
    this.runtime.dispose();
  }

  private disposeVm(vm: QuickJSContext): void {
    if (this.host.debug) {
      // asyncify 0.32 は Runtime の登録を先に外す。ホスト関数を先に解放しておく。
      for (const name of [
        "__debugPause",
        "__debugPending",
        "__debugClock",
        "__debugSeen",
        "__hostCall",
        "__log",
      ])
        vm.setProp(vm.global, name, vm.undefined);
    }
    vm.dispose();
  }

  /** 非同期版だけの実行経路。停止している時間は実行時間の制限に含めない。 */
  async runAsync(
    id: string,
    handler: string,
    entities: ScriptEntity[],
    args: Value[] = [],
  ): Promise<ScriptEntity[]> {
    if (!this.host.debug || this.busy || this.disposeRequested)
      throw new Error("デバッグ実行を開始できません");
    const realm = this.systemRealm.get(id);
    const vm = (realm === undefined ? undefined : this.realms.get(realm)) as
      | QuickJSAsyncContext
      | undefined;
    if (!vm) throw new ScriptError(`System が読み込まれていません: ${id}`, id, "runtime");
    this.busy = true;
    this.currentLimit = this.options.timeLimitMs;
    this.debugDeadline = performance.now() + this.currentLimit;
    this.debugRemaining = null;
    this.overMemory = false;
    this.runtime.setInterruptHandler(() => {
      if (this.memory.buffer.byteLength > this.heapLimit) {
        this.overMemory = true;
        return true;
      }
      return this.disposeRequested || performance.now() > this.debugDeadline;
    });
    const values = [id, handler, stringifyValue(entities), "", stringifyValue(args)];
    // 絞り込みを渡さない呼び出し元では、すべての文をホストへ渡す（遅いが、取りこぼさない）。
    const config: DebugRunConfig = this.host.debug.config?.(id) ?? {
      lines: {},
      stepping: true,
      watch: [],
    };
    try {
      const result = this.unwrap(
        vm,
        await vm.evalCodeAsync(
          `__debugConfigure(${JSON.stringify(JSON.stringify(config))});__run(${values.map((value) => JSON.stringify(value)).join(",")})`,
          "debug-run.js",
        ),
        id,
        "runtime",
      );
      try {
        return parseValue(vm.getString(result)) as ScriptEntity[];
      } finally {
        result.dispose();
      }
    } finally {
      this.runtime.removeInterruptHandler();
      this.busy = false;
      if (this.disposeRequested) this.dispose();
    }
  }

  private realm(name: string): QuickJSContext {
    const existing = this.realms.get(name);
    if (existing) return existing;
    const vm = this.runtime.newContext();
    try {
      this.installHost(vm, name);
      this.withDeadline(this.options.loadTimeLimitMs, () => {
        this.unwrap(
          vm,
          vm.evalCode(
            PRELUDE(
              Object.keys(this.host.hostFunctions ?? {}),
              this.host.syncHostFunctions ?? Object.keys(this.host.hostFunctions ?? {}),
              Boolean(this.host.debug),
            ) + (this.host.debug ? DEBUG_PRELUDE : ""),
            "prelude.js",
          ),
          null,
          "load",
        ).dispose();
      });
    } catch (e) {
      // 準備に失敗した領域を残すと、サンドボックスの破棄で VM ごと落ちる
      this.disposeVm(vm);
      throw e;
    }
    this.realms.set(name, vm);
    return vm;
  }

  private installHost(vm: QuickJSContext, realm: string): void {
    if (this.host.debug) {
      const debug = this.host.debug;
      const pause = (vm as QuickJSAsyncContext).newAsyncifiedFunction(
        "__debugPause",
        async (text) => {
          const point = JSON.parse(vm.getString(text)) as DebugPoint;
          let cancel!: () => void;
          const cancelled = new Promise<null>((resolve) => {
            cancel = () => resolve(null);
          });
          this.cancelWait = cancel;
          try {
            const result = await Promise.race([debug.onPoint(point), cancelled]);
            return vm.newString(
              JSON.stringify(
                this.disposeRequested || result === null
                  ? { abort: true }
                  : { edits: result, stepping: debug.stepping?.() ?? true },
              ),
            );
          } finally {
            this.cancelWait = null;
          }
        },
      );
      vm.setProp(vm.global, "__debugPause", pause);
      pause.dispose();
      const pending = vm.newFunction("__debugPending", () =>
        debug.pending?.() ? vm.true : vm.false,
      );
      vm.setProp(vm.global, "__debugPending", pending);
      pending.dispose();
      // 値を写して待つ間は、実行時間の制限の時計を止める。
      const clock = vm.newFunction("__debugClock", (runH) => {
        if (vm.dump(runH)) {
          if (this.debugRemaining !== null)
            this.debugDeadline = performance.now() + this.debugRemaining;
          this.debugRemaining = null;
        } else if (this.debugRemaining === null) {
          this.debugRemaining = this.debugDeadline - performance.now();
          this.debugDeadline = Number.POSITIVE_INFINITY;
        }
      });
      vm.setProp(vm.global, "__debugClock", clock);
      clock.dispose();
      const seen = vm.newFunction("__debugSeen", () => {
        debug.seen?.();
      });
      vm.setProp(vm.global, "__debugSeen", seen);
      seen.dispose();
    }
    const hostFns = this.host.hostFunctions ?? {};
    const ctxOf = (idH: QuickJSHandle): HostCallContext => ({
      realm,
      systemId: vm.typeof(idH) === "string" ? vm.getString(idH) : null,
    });

    const hostCall = vm.newFunction("__hostCall", (nameH, argsH, idH, entityH, syncH) => {
      if (this.disposeRequested) return vm.undefined;
      const name = vm.getString(nameH);
      const fn = hostFns[name];
      if (!fn) throw new Error(`unknown host function ${name}`);
      const entity = entityH && vm.typeof(entityH) === "string" ? vm.getString(entityH) : null;
      // スクリプトが持っている値を、Host API が World を読む前に書く（ADR 0082）
      const active = this.activeSync;
      if (active && syncH && vm.typeof(syncH) === "string")
        active.sync.push(readEntities(vm.getString(syncH), active.fix));
      const result = fn(parseValue(vm.getString(argsH)) as Value[], { ...ctxOf(idH), entity });
      // Host API が変えた値は、戻り値の前に添えて返す（先頭の \u0001 が目印。JSON の文字には現れない）
      const changed = active?.sync.pull();
      if (active && changed && changed.length > 0) {
        const text = active.fix ? JSON.stringify(encodeValue(changed)) : stringifyValue(changed);
        return vm.newString(
          `\u0001${text}\u0001${result === undefined ? "" : stringifyValue(result)}`,
        );
      }
      return result === undefined ? vm.undefined : vm.newString(stringifyValue(result));
    });
    vm.setProp(vm.global, "__hostCall", hostCall);
    hostCall.dispose();

    const log = vm.newFunction("__log", (idH, msgH) => {
      if (this.disposeRequested) return;
      this.host.onLog?.(vm.getString(msgH), ctxOf(idH));
    });
    vm.setProp(vm.global, "__log", log);
    log.dispose();
  }

  private callGlobal(
    vm: QuickJSContext,
    name: string,
    args: QuickJSHandle[],
    systemId: string | null,
    kind: "load" | "runtime",
  ): string {
    const fn = vm.getProp(vm.global, name);
    try {
      const result = this.unwrap(vm, vm.callFunction(fn, vm.undefined, ...args), systemId, kind);
      try {
        return vm.typeof(result) === "string" ? vm.getString(result) : "";
      } finally {
        result.dispose();
      }
    } finally {
      fn.dispose();
      for (const a of args) if (a.alive) a.dispose();
    }
  }

  private unwrap(
    vm: QuickJSContext,
    result: ReturnType<QuickJSContext["evalCode"]>,
    systemId: string | null,
    kind: "load" | "runtime",
  ): QuickJSHandle {
    if (result.error) {
      const err = vm.dump(result.error) as
        | { name?: string; message?: string; stack?: string }
        | string;
      result.error.dispose();
      const message =
        typeof err === "string" ? err : `${err.name ?? "Error"}: ${err.message ?? ""}`;
      if (typeof err === "object" && err.message === "interrupted" && this.overMemory) {
        this.broken = true;
        throw new ScriptError("メモリ上限を超えたため停止しました", systemId, "memory");
      }
      if (typeof err === "object" && err.message === "interrupted") {
        throw new ScriptError(
          `時間制限（${this.currentLimit}ms）を超えたため停止しました`,
          systemId,
          "timeout",
        );
      }
      if (/out of memory/i.test(message)) {
        throw new ScriptError("メモリ上限を超えたため停止しました", systemId, "memory");
      }
      const line = typeof err === "object" ? lineInStack(err.stack, systemId) : null;
      throw new ScriptError(message, systemId, kind, line);
    }
    return result.value;
  }

  private withDeadline<T>(limitMs: number, fn: () => T): T {
    if (this.broken) {
      throw new ScriptError("サンドボックスはメモリ超過で停止済みです", null, "memory");
    }
    const deadline = performance.now() + limitMs;
    this.currentLimit = limitMs;
    this.overMemory = false;
    this.runtime.setInterruptHandler(() => {
      if (this.memory.buffer.byteLength > this.heapLimit) {
        this.overMemory = true;
        return true;
      }
      return performance.now() > deadline;
    });
    try {
      return fn();
    } finally {
      this.runtime.removeInterruptHandler();
    }
  }
}
