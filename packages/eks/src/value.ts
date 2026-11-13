/**
 * 保存できる値と、その書き出し・読み込み（ADR 0065）。
 *
 * メモリの上では、ふつうの JavaScript の値（`undefined`・`Date`・`Map`・`Set`・`bigint`・`NaN` を含む）で持つ。
 * Git のファイル・Yjs・通信・スクリプトの実行環境（QuickJS）へ渡すときだけ、タグ付きの JSON に書き出す。
 * JSON で表せない値だけを `"$t"` のキーを持つオブジェクトにし、ほかはふつうの JSON のままにする。
 */

/** 保存できる値 */
export type Value =
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | Date
  | Value[]
  | { [key: string]: Value }
  | Map<Value, Value>
  | Set<Value>;

/** 書き出した形（ふつうの JSON） */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ValueCodec {
  /** 値を、タグ付きの JSON に書き出す。入れ物（配列・オブジェクト）は新しく作る */
  encode(value: unknown): Json;
  /** タグ付きの JSON から値に戻す。形式に合わないタグは TypeError にする */
  decode(json: unknown): unknown;
}

/** `createValueCodec` の中で使う処理の型（中の処理どうしが呼び合うので、先に決めておく） */
interface CodecSteps {
  put(target: Record<string, unknown>, key: string, value: unknown): void;
  fail(what: string): never;
  encode(value: unknown, viaToJson: boolean): Json;
  decodeProps(json: Record<string, unknown>): Record<string, unknown>;
  decode(json: unknown): unknown;
}

/**
 * 書き出しと読み込みを作る。
 *
 * この関数の文（`toString()`）を、そのまま QuickJS の prelude に入れて、ホストと同じ処理を
 * スクリプトの側でも動かす（`VALUE_CODEC_SOURCE`）。そのため、次の決まりで書く。
 * - 外の変数や import を使わない。
 * - 中の処理は、オブジェクトのメソッドとして書く。`const f = () => {}` や `function f() {}` の形で
 *   名前の付く関数を作らない。tsx（esbuild の keepNames）は、名前の付く関数を外の補助 `__name()` で包むので、
 *   QuickJS で「__name がない」と落ちる（開発サーバーとベンチで起きる。docs/DEVELOPMENT.md）。
 * - ビルドが補助の関数を足さないよう、書き方も古めにそろえる（スプレッドや `?.` を使わない）。
 */
export function createValueCodec(): ValueCodec {
  const TAG = "$t";
  /** bigint の桁数の上限。大きすぎる数の読み込みで、サーバーや実行が止まらないようにする */
  const MAX_BIGINT_DIGITS = 4096;
  const hasOwn = Object.prototype.hasOwnProperty;
  const tagOf = Object.prototype.toString;

  const steps: CodecSteps = {
    put(target, key, value) {
      // "__proto__" への代入は、プロパティではなく原型の差し替えになる
      if (key === "__proto__") {
        Object.defineProperty(target, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        target[key] = value;
      }
    },

    fail(what) {
      throw new TypeError(`値の形式が正しくありません（${what}）`);
    },

    encode(value, viaToJson) {
      switch (typeof value) {
        case "string":
        case "boolean":
          return value;
        case "number":
          return Number.isFinite(value) ? value : { $t: "number", v: String(value) };
        case "undefined":
          return { $t: "undefined" };
        case "bigint": {
          const digits = value.toString();
          if (digits.length > MAX_BIGINT_DIGITS + 1)
            throw new RangeError(`bigint が大きすぎます（${MAX_BIGINT_DIGITS} 桁まで）`);
          return { $t: "bigint", v: digits };
        }
        case "object":
          break;
        default:
          // 関数・symbol は保存できない。JSON と同じく null にする
          return null;
      }
      if (value === null) return null;
      if (Array.isArray(value)) {
        const list: Json[] = new Array(value.length);
        for (let i = 0; i < value.length; i++) list[i] = steps.encode(value[i], false);
        return list;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        const kind = tagOf.call(value);
        if (kind === "[object Date]") {
          const time = (value as Date).getTime();
          return { $t: "Date", v: Number.isNaN(time) ? "" : (value as Date).toISOString() };
        }
        if (kind === "[object Map]") {
          const entries: Json[] = [];
          (value as Map<unknown, unknown>).forEach((v, k) => {
            entries.push([steps.encode(k, false), steps.encode(v, false)]);
          });
          return { $t: "Map", v: entries };
        }
        if (kind === "[object Set]") {
          const items: Json[] = [];
          (value as Set<unknown>).forEach((v) => {
            items.push(steps.encode(v, false));
          });
          return { $t: "Set", v: items };
        }
      }
      const source = value as Record<string, unknown>;
      // JSON と同じく、toJSON() があればその結果を書き出す（import した KokoState は ID になる）
      if (!viaToJson && typeof source.toJSON === "function")
        return steps.encode((source.toJSON as () => unknown)(), true);
      const out: Record<string, Json> = {};
      const keys = Object.keys(source);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i] as string;
        const v = source[key];
        if (typeof v === "function" || typeof v === "symbol") continue;
        steps.put(out, key, steps.encode(v, false));
      }
      // "$t" のキーを持つふつうのオブジェクトは、タグと取り違えないように包む
      return hasOwn.call(out, TAG) ? { $t: "object", v: out } : out;
    },

    decodeProps(json) {
      const out: Record<string, unknown> = {};
      const keys = Object.keys(json);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i] as string;
        steps.put(out, key, steps.decode(json[key]));
      }
      return out;
    },

    decode(json) {
      if (json === null || typeof json !== "object") return json;
      if (Array.isArray(json)) {
        const list: unknown[] = new Array(json.length);
        for (let i = 0; i < json.length; i++) list[i] = steps.decode(json[i]);
        return list;
      }
      const source = json as Record<string, unknown>;
      if (!hasOwn.call(source, TAG)) return steps.decodeProps(source);
      const v = source.v;
      switch (source[TAG]) {
        case "undefined":
          return undefined;
        case "number":
          if (v === "NaN") return Number.NaN;
          if (v === "Infinity") return Number.POSITIVE_INFINITY;
          if (v === "-Infinity") return Number.NEGATIVE_INFINITY;
          break;
        case "bigint":
          if (typeof v === "string" && v.length <= MAX_BIGINT_DIGITS + 1 && /^-?\d+$/.test(v))
            return BigInt(v);
          break;
        case "Date":
          if (typeof v === "string") return new Date(v);
          break;
        case "Map":
          if (Array.isArray(v)) {
            const map = new Map<unknown, unknown>();
            for (let i = 0; i < v.length; i++) {
              const entry = v[i];
              if (!Array.isArray(entry) || entry.length !== 2) return steps.fail("Map");
              map.set(steps.decode(entry[0]), steps.decode(entry[1]));
            }
            return map;
          }
          break;
        case "Set":
          if (Array.isArray(v)) {
            const set = new Set<unknown>();
            for (let i = 0; i < v.length; i++) set.add(steps.decode(v[i]));
            return set;
          }
          break;
        case "object":
          if (v !== null && typeof v === "object" && !Array.isArray(v))
            return steps.decodeProps(v as Record<string, unknown>);
          break;
      }
      return steps.fail(`${TAG}: ${String(source[TAG])}`);
    },
  };

  return {
    encode(value) {
      return steps.encode(value, false);
    },
    decode(json) {
      return steps.decode(json);
    },
  };
}

/**
 * `createValueCodec` の文。QuickJS の prelude に `(${VALUE_CODEC_SOURCE})()` の形で入れる。
 * ホストと QuickJS で、同じ処理を二つ書かない（ADR 0065）。
 */
export const VALUE_CODEC_SOURCE: string = createValueCodec.toString();

const codec = createValueCodec();

/** 値を、タグ付きの JSON に書き出す */
export const encodeValue: (value: unknown) => Json = codec.encode;

/** タグ付きの JSON から値に戻す */
export const decodeValue: (json: unknown) => unknown = codec.decode;

/** 値を、タグ付きの JSON の文字にする（`JSON.stringify` の代わり） */
export function stringifyValue(value: unknown, space?: number): string {
  return JSON.stringify(codec.encode(value), null, space);
}

/** タグ付きの JSON の文字から値に戻す（`JSON.parse` の代わり） */
export function parseValue(text: string): unknown {
  return codec.decode(JSON.parse(text));
}

/** タグ付きの JSON の中に、タグ（`"$t"` のキーを持つオブジェクト）があるか */
export function hasTag(json: Json): boolean {
  if (json === null || typeof json !== "object") return false;
  if (Array.isArray(json)) {
    for (let i = 0; i < json.length; i++) if (hasTag(json[i] as Json)) return true;
    return false;
  }
  if (Object.hasOwn(json, "$t")) return true;
  for (const key of Object.keys(json)) if (hasTag(json[key] as Json)) return true;
  return false;
}

/** ふつうのオブジェクトか（配列・`Date`・`Map`・`Set`・クラスのインスタンスではない） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const kindOf = (value: object): string => Object.prototype.toString.call(value);

/**
 * 値の複製（入れ子の中まで）。毎ステップ全 Entity 分呼ばれるので、数・文字などはそのまま返す
 * （`structuredClone` は数 1 つでも重い）。
 */
export function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const list: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) list[i] = cloneValue(value[i]);
    return list as T;
  }
  if (!isPlainObject(value)) {
    const kind = kindOf(value);
    if (kind === "[object Date]") return new Date((value as unknown as Date).getTime()) as T;
    if (kind === "[object Map]") {
      const map = new Map<unknown, unknown>();
      for (const [k, v] of value as unknown as Map<unknown, unknown>)
        map.set(cloneValue(k), cloneValue(v));
      return map as T;
    }
    if (kind === "[object Set]") {
      const set = new Set<unknown>();
      for (const v of value as unknown as Set<unknown>) set.add(cloneValue(v));
      return set as T;
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const v = cloneValue((value as Record<string, unknown>)[key]);
    if (key === "__proto__")
      Object.defineProperty(out, key, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else out[key] = v;
  }
  return out as T;
}

/**
 * 2 つの値が同じか（入れ子の中まで）。`NaN` どうしは同じ、オブジェクトはキーの並びを問わない。
 * `Map` と `Set` は、並びも同じときに同じとする。差分・戻す・変化の印と、実行での書き込みの判定に使う。
 */
export function equalValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equalValues(a[i], b[i])) return false;
    return true;
  }
  const plainA = isPlainObject(a);
  if (plainA !== isPlainObject(b)) return false;
  if (!plainA) {
    const kind = kindOf(a);
    if (kind !== kindOf(b)) return false;
    if (kind === "[object Date]") {
      const ta = (a as Date).getTime();
      const tb = (b as Date).getTime();
      return ta === tb || (Number.isNaN(ta) && Number.isNaN(tb));
    }
    if (kind === "[object Map]") {
      const ea = [...(a as Map<unknown, unknown>)];
      const eb = [...(b as Map<unknown, unknown>)];
      return ea.length === eb.length && equalValues(ea, eb);
    }
    if (kind === "[object Set]") {
      const ea = [...(a as Set<unknown>)];
      const eb = [...(b as Set<unknown>)];
      return ea.length === eb.length && equalValues(ea, eb);
    }
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.hasOwn(b, key)) return false;
    if (!equalValues((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
      return false;
  }
  return true;
}
