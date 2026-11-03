import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** スクリプトから見える Entity。KokoState 名 → フィールド名 → 値。 */
export interface ScriptEntity {
  id: string;
  /** KokoState の ID（その領域の中の ID）→ フィールド名 → 値。names がなければ、キーは名前として扱う */
  states: Record<string, Record<string, Json>>;
  /** 名前 → states のキー。名前が一つに決まる KokoState だけ（移行の間の e.Gun のため。ADR 0010） */
  names?: Record<string, string>;
}

/** スクリプトが宣言した System の情報（Query は KokoState 名で書かれる）。 */
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
export type HostFunction = (args: Json[], ctx: HostCallContext) => Json | undefined;

export interface SandboxOptions {
  /** ハンドラ 1 回の呼び出しで使える時間。超えたら中断する。 */
  timeLimitMs?: number;
  /** 読み込み（領域の準備・スクリプトの評価）で使える時間。初回は VM の準備が入るので長めにする。 */
  loadTimeLimitMs?: number;
  /** VM 全体のメモリ上限。 */
  memoryLimitBytes?: number;
  hostFunctions?: Record<string, HostFunction>;
  onLog?: (message: string, ctx: HostCallContext) => void;
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

/** QuickJS のスタックから、その System のファイルの行番号を取り出す */
export function lineInStack(stack: string | undefined, systemId: string | null): number | null {
  if (!stack || !systemId) return null;
  const esc = systemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`/${esc}\\.js:(\\d+)`).exec(stack);
  return m ? Number(m[1]) : null;
}

const PRELUDE = (hostNames: string[]) => `
"use strict";
const __systems = Object.create(null);
let __current = null;
// いま処理している Entity（Host API の呼び出しが、どの配置のためのものかを決める。ADR 0012）
let __entity = null;
globalThis.system = (def) => {
  if (def === null || typeof def !== "object") throw new TypeError("system() には設定オブジェクトを渡してください");
  return def;
};
// import した KokoState（コンパイラが const X = __koko(ID, 名前) に書き換える。ADR 0010）
// 文字列としては ID になる（Query の with に入れる・e[X]・world.get(id, X) で ID として届く）
globalThis.__koko = (id, name) => Object.freeze({
  id, name,
  toString() { return id; },
  toJSON() { return id; },
});
// KokoState を指すもの（import した値・ID・名前）を、その Entity の states のキーにする
const __kokoKey = (k, names) => {
  if (k !== null && typeof k === "object" && typeof k.id === "string") return k.id;
  const s = String(k);
  return names && Object.hasOwn(names, s) ? names[s] : s;
};
globalThis.log = (...args) => __log(__current, args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
globalThis.console = { log: globalThis.log, warn: globalThis.log, error: globalThis.log };
const __ns = {};
for (const full of ${JSON.stringify(hostNames)}) {
  const [ns, fn] = full.split(".");
  (__ns[ns] ??= {})[fn] = (...args) => {
    const r = __hostCall(full, JSON.stringify(args), __current, __entity);
    return r === undefined ? undefined : JSON.parse(r);
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
  const asList = (v) => Array.isArray(v) ? v.map(String) : [];
  const handlers = Object.keys(def).filter((k) => k.startsWith("on") && typeof def[k] === "function");
  // 公開 Contract：contracts: { Damage(e, payload) {...} }（ADR 0012）
  const contracts = def.contracts !== null && typeof def.contracts === "object" ? def.contracts : {};
  for (const k of Object.keys(contracts)) if (typeof contracts[k] === "function") handlers.push("contract:" + k);
  __systems[id] = def;
  return JSON.stringify({ query: { with: asList(q.with), without: asList(q.without) }, handlers });
};
globalThis.__undefine = (id) => { delete __systems[id]; };
globalThis.__run = (id, handler, entitiesJson, argsJson) => {
  const def = __systems[id];
  const fn = def && (handler.startsWith("contract:")
    ? (def.contracts && def.contracts[handler.slice("contract:".length)])
    : def[handler]);
  if (typeof fn !== "function") return entitiesJson;
  const entities = JSON.parse(entitiesJson);
  const args = JSON.parse(argsJson);
  __current = id;
  try {
    for (const e of entities) {
      __entity = e.id;
      const st = e.states;
      // names がないとき（古い形）は、states のキーをそのまま名前として扱う
      const names = e.names ?? Object.fromEntries(Object.keys(st).map((k) => [k, k]));
      const view = { id: e.id };
      const slot = (key) => ({ get: () => st[key], set: (v) => { st[key] = v; }, configurable: true });
      // ID でも引ける（e[Gun]）。一覧には出さない
      for (const key of Object.keys(st)) Object.defineProperty(view, key, { ...slot(key), enumerable: false });
      // 名前が一つに決まる KokoState は、名前でも使える（e.Gun。移行の間の書き方）
      for (const [name, key] of Object.entries(names)) Object.defineProperty(view, name, { ...slot(key), enumerable: true });
      // entity.get(Gun)：import した KokoState（または ID・名前）でその値を取る
      Object.defineProperty(view, "get", { value: (k) => st[__kokoKey(k, names)], enumerable: false });
      fn.call(handler.startsWith("contract:") ? def.contracts : def, view, ...args);
    }
  } finally {
    __current = null;
    __entity = null;
  }
  return JSON.stringify(entities);
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
 * - Entity の値は呼び出しごとに JSON でまとめて受け渡す（境界をまたぐ回数を減らす）。
 */
export class ScriptSandbox {
  /** メモリ超過で止まった。以後の呼び出しは失敗するので作り直すこと。 */
  broken = false;
  private heapLimit = Number.POSITIVE_INFINITY;
  private overMemory = false;
  private currentLimit = 0;
  private readonly realms = new Map<string, QuickJSContext>();
  private readonly systemRealm = new Map<string, string>();

  private constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly runtime: QuickJSRuntime,
    private readonly options: Required<Omit<SandboxOptions, "hostFunctions" | "onLog">>,
    private readonly host: Pick<SandboxOptions, "hostFunctions" | "onLog">,
  ) {}

  static async create(options: SandboxOptions = {}): Promise<ScriptSandbox> {
    // リリース版の同期ビルドだけを使う（デバッグ版などを配信物に含めない）
    const QuickJS = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
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
      onLog: options.onLog,
    });
    sandbox.heapLimit = sandbox.memory.buffer.byteLength + opts.memoryLimitBytes;
    return sandbox;
  }

  /**
   * System スクリプト（`export default system({...})`）を指定の領域に読み込む。
   * 同じ ID は置き換える（別の領域へ移す場合も、元の領域からは取り除く）。
   */
  loadSystem(id: string, source: string, realm = "default"): SystemMeta {
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
    const vm = this.realms.get(realm);
    if (!vm) return;
    for (const [id, r] of [...this.systemRealm]) if (r === realm) this.systemRealm.delete(id);
    this.realms.delete(realm);
    vm.dispose();
  }

  /** ハンドラ（onUpdate など）を Entity ごとに呼び、変更後の値を返す。 */
  run(id: string, handler: string, entities: ScriptEntity[], args: Json[] = []): ScriptEntity[] {
    const realm = this.systemRealm.get(id);
    const vm = realm === undefined ? undefined : this.realms.get(realm);
    if (!vm) throw new ScriptError(`System が読み込まれていません: ${id}`, id, "runtime");
    return this.withDeadline(this.options.timeLimitMs, () => {
      const out = this.callGlobal(
        vm,
        "__run",
        [
          vm.newString(id),
          vm.newString(handler),
          vm.newString(JSON.stringify(entities)),
          vm.newString(JSON.stringify(args)),
        ],
        id,
        "runtime",
      );
      return JSON.parse(out) as ScriptEntity[];
    });
  }

  dispose(): void {
    for (const vm of this.realms.values()) vm.dispose();
    this.realms.clear();
    this.systemRealm.clear();
    this.runtime.dispose();
  }

  private realm(name: string): QuickJSContext {
    const existing = this.realms.get(name);
    if (existing) return existing;
    const vm = this.runtime.newContext();
    this.installHost(vm, name);
    this.withDeadline(this.options.loadTimeLimitMs, () => {
      this.unwrap(
        vm,
        vm.evalCode(PRELUDE(Object.keys(this.host.hostFunctions ?? {})), "prelude.js"),
        null,
        "load",
      ).dispose();
    });
    this.realms.set(name, vm);
    return vm;
  }

  private installHost(vm: QuickJSContext, realm: string): void {
    const hostFns = this.host.hostFunctions ?? {};
    const ctxOf = (idH: QuickJSHandle): HostCallContext => ({
      realm,
      systemId: vm.typeof(idH) === "string" ? vm.getString(idH) : null,
    });

    const hostCall = vm.newFunction("__hostCall", (nameH, argsH, idH, entityH) => {
      const name = vm.getString(nameH);
      const fn = hostFns[name];
      if (!fn) throw new Error(`unknown host function ${name}`);
      const entity = entityH && vm.typeof(entityH) === "string" ? vm.getString(entityH) : null;
      const result = fn(JSON.parse(vm.getString(argsH)) as Json[], { ...ctxOf(idH), entity });
      return result === undefined ? vm.undefined : vm.newString(JSON.stringify(result));
    });
    vm.setProp(vm.global, "__hostCall", hostCall);
    hostCall.dispose();

    const log = vm.newFunction("__log", (idH, msgH) => {
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
