import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** スクリプトから見える Entity。KokoState 名 → フィールド名 → 値。 */
export interface ScriptEntity {
  id: string;
  states: Record<string, Record<string, Json>>;
}

/** スクリプトが宣言した System の情報（Query は KokoState 名で書かれる）。 */
export interface SystemMeta {
  query: { with: string[]; without: string[] };
  handlers: string[];
}

/** スクリプトから呼べるホスト関数。名前は "world.raycast" のように「名前空間.関数名」。 */
export type HostFunction = (...args: Json[]) => Json | undefined;

export interface SandboxOptions {
  /** 1回の呼び出し（ロード・ハンドラ実行）で使える時間。超えたら中断する。 */
  timeLimitMs?: number;
  /** VM 全体のメモリ上限。 */
  memoryLimitBytes?: number;
  hostFunctions?: Record<string, HostFunction>;
  onLog?: (systemId: string | null, message: string) => void;
}

export class ScriptError extends Error {
  constructor(
    message: string,
    readonly systemId: string | null,
    readonly kind: "load" | "runtime" | "timeout" | "memory",
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

const PRELUDE = (hostNames: string[]) => `
"use strict";
const __systems = Object.create(null);
let __current = null;
globalThis.system = (def) => {
  if (def === null || typeof def !== "object") throw new TypeError("system() には設定オブジェクトを渡してください");
  return def;
};
globalThis.log = (...args) => __log(__current, args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
globalThis.console = { log: globalThis.log, warn: globalThis.log, error: globalThis.log };
const __ns = {};
for (const full of ${JSON.stringify(hostNames)}) {
  const [ns, fn] = full.split(".");
  (__ns[ns] ??= {})[fn] = (...args) => {
    const r = __hostCall(full, JSON.stringify(args));
    return r === undefined ? undefined : JSON.parse(r);
  };
}
for (const [ns, obj] of Object.entries(__ns)) globalThis[ns] = Object.freeze(obj);

globalThis.__define = (id, def) => {
  const q = def.query ?? {};
  const asList = (v) => Array.isArray(v) ? v.map(String) : [];
  const handlers = Object.keys(def).filter((k) => k.startsWith("on") && typeof def[k] === "function");
  __systems[id] = def;
  return JSON.stringify({ query: { with: asList(q.with), without: asList(q.without) }, handlers });
};
globalThis.__undefine = (id) => { delete __systems[id]; };
globalThis.__run = (id, handler, entitiesJson, argsJson) => {
  const def = __systems[id];
  const fn = def && def[handler];
  if (typeof fn !== "function") return entitiesJson;
  const entities = JSON.parse(entitiesJson);
  const args = JSON.parse(argsJson);
  __current = id;
  try {
    for (const e of entities) {
      const view = { id: e.id, ...e.states };
      fn.call(def, view, ...args);
      for (const k of Object.keys(e.states)) e.states[k] = view[k];
    }
  } finally {
    __current = null;
  }
  return JSON.stringify(entities);
};
`;

/**
 * 利用者の System スクリプトを、ページとは別の QuickJS VM で動かす。
 * - DOM・ネットワーク・ページのグローバルには触れられない。
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

  private constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly runtime: QuickJSRuntime,
    private readonly vm: QuickJSContext,
    private readonly options: Required<Omit<SandboxOptions, "hostFunctions" | "onLog">>,
  ) {}

  static async create(options: SandboxOptions = {}): Promise<ScriptSandbox> {
    const QuickJS = await newQuickJSWASMModule();
    const runtime = QuickJS.newRuntime();
    const opts = {
      timeLimitMs: options.timeLimitMs ?? 20,
      memoryLimitBytes: options.memoryLimitBytes ?? 32 * 1024 * 1024,
    };
    runtime.setMemoryLimit(opts.memoryLimitBytes);
    runtime.setMaxStackSize(512 * 1024);
    const vm = runtime.newContext();
    const sandbox = new ScriptSandbox(QuickJS.getWasmMemory(), runtime, vm, opts);
    sandbox.installHost(options);
    sandbox.withDeadline(() => {
      sandbox
        .unwrap(
          vm.evalCode(PRELUDE(Object.keys(options.hostFunctions ?? {})), "prelude.js"),
          null,
          "load",
        )
        .dispose();
    });
    sandbox.heapLimit = sandbox.memory.buffer.byteLength + opts.memoryLimitBytes;
    return sandbox;
  }

  /** System スクリプト（`export default system({...})`）を読み込む。同じ ID は置き換える。 */
  loadSystem(id: string, source: string): SystemMeta {
    return this.withDeadline(() => {
      const exportsHandle = this.unwrap(
        this.vm.evalCode(source, `${id}.js`, { type: "module", strict: true }),
        id,
        "load",
      );
      try {
        const def = this.vm.getProp(exportsHandle, "default");
        try {
          if (this.vm.typeof(def) !== "object") {
            throw new ScriptError("export default system({...}) が見つかりません", id, "load");
          }
          const meta = this.callGlobal("__define", [this.vm.newString(id), def], id, "load");
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
    this.callGlobal("__undefine", [this.vm.newString(id)], id, "runtime");
  }

  /** ハンドラ（onUpdate など）を Entity ごとに呼び、変更後の値を返す。 */
  run(id: string, handler: string, entities: ScriptEntity[], args: Json[] = []): ScriptEntity[] {
    return this.withDeadline(() => {
      const out = this.callGlobal(
        "__run",
        [
          this.vm.newString(id),
          this.vm.newString(handler),
          this.vm.newString(JSON.stringify(entities)),
          this.vm.newString(JSON.stringify(args)),
        ],
        id,
        "runtime",
      );
      return JSON.parse(out) as ScriptEntity[];
    });
  }

  memoryUsageBytes(): number {
    const handle = this.runtime.computeMemoryUsage();
    try {
      const usage = this.vm.dump(handle) as { memory_used_size?: number };
      return usage.memory_used_size ?? 0;
    } finally {
      handle.dispose();
    }
  }

  dispose(): void {
    this.vm.dispose();
    this.runtime.dispose();
  }

  private installHost(options: SandboxOptions): void {
    const hostFns = options.hostFunctions ?? {};
    const hostCall = this.vm.newFunction("__hostCall", (nameH, argsH) => {
      const name = this.vm.getString(nameH);
      const fn = hostFns[name];
      if (!fn) throw new Error(`unknown host function ${name}`);
      const result = fn(...(JSON.parse(this.vm.getString(argsH)) as Json[]));
      return result === undefined ? this.vm.undefined : this.vm.newString(JSON.stringify(result));
    });
    this.vm.setProp(this.vm.global, "__hostCall", hostCall);
    hostCall.dispose();

    const log = this.vm.newFunction("__log", (idH, msgH) => {
      const id = this.vm.typeof(idH) === "string" ? this.vm.getString(idH) : null;
      options.onLog?.(id, this.vm.getString(msgH));
    });
    this.vm.setProp(this.vm.global, "__log", log);
    log.dispose();
  }

  private callGlobal(
    name: string,
    args: QuickJSHandle[],
    systemId: string | null,
    kind: "load" | "runtime",
  ): string {
    const fn = this.vm.getProp(this.vm.global, name);
    try {
      const result = this.unwrap(
        this.vm.callFunction(fn, this.vm.undefined, ...args),
        systemId,
        kind,
      );
      try {
        return this.vm.typeof(result) === "string" ? this.vm.getString(result) : "";
      } finally {
        result.dispose();
      }
    } finally {
      fn.dispose();
      for (const a of args) if (a.alive) a.dispose();
    }
  }

  private unwrap(
    result: ReturnType<QuickJSContext["evalCode"]>,
    systemId: string | null,
    kind: "load" | "runtime",
  ): QuickJSHandle {
    if (result.error) {
      const err = this.vm.dump(result.error) as { name?: string; message?: string } | string;
      result.error.dispose();
      const message =
        typeof err === "string" ? err : `${err.name ?? "Error"}: ${err.message ?? ""}`;
      if (typeof err === "object" && err.message === "interrupted" && this.overMemory) {
        this.broken = true;
        throw new ScriptError("メモリ上限を超えたため停止しました", systemId, "memory");
      }
      if (typeof err === "object" && err.message === "interrupted") {
        throw new ScriptError(
          `時間制限（${this.options.timeLimitMs}ms）を超えたため停止しました`,
          systemId,
          "timeout",
        );
      }
      if (/out of memory/i.test(message)) {
        throw new ScriptError("メモリ上限を超えたため停止しました", systemId, "memory");
      }
      throw new ScriptError(message, systemId, kind);
    }
    return result.value;
  }

  private withDeadline<T>(fn: () => T): T {
    if (this.broken) {
      throw new ScriptError("サンドボックスはメモリ超過で停止済みです", null, "memory");
    }
    const deadline = performance.now() + this.options.timeLimitMs;
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
