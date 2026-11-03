import { z } from "zod";
import type { CapabilityId, HostApiPolicy } from "./capabilities";
import type { HostName } from "./simulation";

/**
 * Host API の一つの定義（計画 UGC U1・ロードマップ「2. スクリプト境界の堅牢化」）。
 * ここから、引数の検証（HOST_API_ARGS）、権限の分類（HOST_API_POLICY）、拒んだときの値、
 * 利用者向けの型の宣言（hostApiDeclarations）、エディタの入力補完（hostApiCompletions）を作る。
 * Host API を足すときは、ここに一件足す（HOST_API の一覧と一致することをテストで検査する）。
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const vec3 = z.tuple([z.number(), z.number(), z.number()], {
  error: "[x, y, z] の形の数値の配列を渡してください",
});
const entityId = z.string({ error: "Entity の ID（文字列）を渡してください" });
/** 無効なら「無いもの」として扱う（今まで黙って無視していた引数のため） */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const record = z.record(z.string(), z.unknown());

/**
 * API の安定度（ADR 0019）。experimental：互換性なく変えうる／preview：変えるときは major を上げ、移し方と診断を
 * 用意する／stable：同じ major の中では後方互換を守る／deprecated：後継があり、いずれ外す。
 * 今はすべて experimental（ワークショップができ、実際の作品で使われてから上げる）。
 */
export type Stability = "experimental" | "preview" | "stable" | "deprecated";

/** 印を付けないものの安定度 */
export const DEFAULT_STABILITY: Stability = "experimental";

interface SpecEntry<A extends z.ZodType> extends HostApiPolicy {
  /** 引数（QuickJS から届いた unknown を検証する） */
  args: A;
  /** 実効権限で拒んだときに返す値（見つからない・できなかったと同じ形） */
  denied: Json | undefined;
  /** 利用者向けの型：引数と戻り値 */
  params: string;
  returns: string;
  /** 利用者向けの説明 */
  doc: string;
  /** 安定度（書かなければ DEFAULT_STABILITY） */
  stability?: Stability;
}

const entry = <A extends z.ZodType>(e: SpecEntry<A>) => ({
  ...e,
  stability: e.stability ?? DEFAULT_STABILITY,
});

const BAG_NOTE =
  "E で押された Interact を受けている間だけ、押した人のバッグ（どの配置にも属さない）に触れる。種類は import したライブラリの KokoState だけ（ADR 0018）";

export const HOST_API_SPEC = {
  "bag.add": entry({
    args: z
      .tuple([
        z.string({ error: "持ち物の種類（import したライブラリの KokoState）を渡してください" }),
        lenient(record),
      ])
      .rest(z.unknown()),
    capability: "bag.write",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "server-revalidate",
    note: BAG_NOTE,
    denied: false,
    params: "(type: KokoState, values?: Record<string, unknown>)",
    returns: "boolean",
    doc: "E で押した人のバッグに 1 個入れる（Interact の中だけ）。値は type の定義で確かめる。いっぱい（64 個）なら false",
  }),
  "bag.take": entry({
    args: z
      .tuple([
        z.string({ error: "持ち物の種類（import したライブラリの KokoState）を渡してください" }),
        lenient(record),
      ])
      .rest(z.unknown()),
    capability: "bag.write",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "server-revalidate",
    note: BAG_NOTE,
    denied: null,
    params: "(type: KokoState, match?: Record<string, unknown>)",
    returns: "Record<string, unknown> | null",
    doc: "E で押した人のバッグから、match のフィールドが一致する type を 1 個取り出して値を返す（Interact の中だけ。なければ null）",
  }),
  "bag.count": entry({
    args: z
      .tuple([
        z.string({ error: "持ち物の種類（import したライブラリの KokoState）を渡してください" }),
      ])
      .rest(z.unknown()),
    capability: "bag.read",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "runtime-host",
    note: BAG_NOTE,
    denied: 0,
    params: "(type: KokoState)",
    returns: "number",
    doc: "E で押した人のバッグに、type がいくつあるか（Interact の中だけ）",
  }),
  "bag.list": entry({
    args: z
      .tuple([
        z.string({ error: "持ち物の種類（import したライブラリの KokoState）を渡してください" }),
      ])
      .rest(z.unknown()),
    capability: "bag.read",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "runtime-host",
    note: BAG_NOTE,
    denied: [],
    params: "(type: KokoState)",
    returns: "Record<string, unknown>[]",
    doc: "E で押した人のバッグの、type の値の一覧（Interact の中だけ）",
  }),
  "time.now": entry({
    args: z.tuple([]).rest(z.unknown()),
    capability: "time.read",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "runtime-host",
    note: "読むだけ。対象を取らない",
    denied: null,
    params: "()",
    returns: "number",
    doc: "再生を始めてからの時間（秒）",
  }),
  "audio.play": entry({
    args: z
      .tuple([lenient(z.string()), lenient(z.string()), lenient(z.number())])
      .rest(z.unknown()),
    capability: "audio.play",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "runtime-host",
    note: "鳴らす素材は自分の領域のもの。数の上限あり（32）。別の参加者へ配る分は将来サーバーで quota を検証",
    denied: false,
    params: "(clip?: string | null, entity?: string, volume?: number)",
    returns: "boolean",
    doc: "音を鳴らす。clip は素材の名前か ID。null なら entity の AudioSource の音。entity を渡すと、その位置から聞こえる",
  }),
  "world.raycast": entry({
    args: z
      .tuple([
        vec3,
        vec3,
        lenient(z.number()),
        lenient(z.object({ exclude: lenient(z.array(z.string())) })),
      ])
      .rest(z.unknown()),
    capability: "physics.raycast",
    currentReach: "any-placement",
    crossPlacement: "target-policy",
    authority: "runtime-host",
    note: "U2：別の配置に当たったときは生の Entity ID を返さず、opaque handle（token）だけを返す。相手が private なら当たらない",
    denied: null,
    params: "(origin: Vec3, direction: Vec3, max?: number)",
    returns: "Hit | null",
    doc: "光線を飛ばし、当たった物を返す。別の作者の物に当たったときは hit.entity が null（hit.send / hit.effect は使える）",
  }),
  "world.emit": entry({
    args: z
      .tuple([entityId, z.string({ error: "イベント名（文字列）を渡してください" }), z.unknown()])
      .rest(z.unknown()),
    capability: "interaction.send",
    currentReach: "own-placement",
    crossPlacement: "public-contract",
    authority: "server-revalidate",
    note: "U2 で、同じ配置の中だけにした。別の配置へは contract.send（公開 Contract）で送る",
    denied: undefined,
    params: "(entity: string, name: string, data?: unknown)",
    returns: "void",
    doc: "同じ配置の Entity にイベントを送る（受ける側は onEvent）。別の作者の物へは hit.send を使う",
  }),
  "world.find": entry({
    args: z.tuple([lenient(z.string())]).rest(z.unknown()),
    capability: "entity.discover",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "runtime-host",
    note: "U1 で、自分の配置の中だけを探すようにした（別の配置は「見つからない」）",
    denied: null,
    params: "(name: string)",
    returns: "string | null",
    doc: "同じ配置の中から、名前で Entity を探して ID を返す",
  }),
  "world.get": entry({
    args: z.tuple([lenient(z.string()), lenient(z.string())]).rest(z.unknown()),
    capability: "state.read",
    currentReach: "own-placement",
    crossPlacement: "target-policy",
    authority: "runtime-host",
    note: "U1 で、自分の配置の Entity だけにした（同じ領域でも別の配置は「見つからない」）",
    denied: null,
    params: "(entity: string, koko: KokoState | string)",
    returns: "Record<string, unknown> | null",
    doc: "同じ配置の Entity の KokoState の値を読む",
  }),
  "world.set": entry({
    args: z.tuple([lenient(z.string()), lenient(z.string()), lenient(record)]).rest(z.unknown()),
    capability: "state.write",
    currentReach: "own-placement",
    crossPlacement: "target-policy",
    authority: "server-revalidate",
    note: "別の持ち主の永続状態を変えるものは、サーバーの判定なしに保護済みとしない",
    denied: false,
    params: "(entity: string, koko: KokoState | string, values: Record<string, unknown>)",
    returns: "boolean",
    doc: "同じ配置の Entity の KokoState の値を書く",
  }),
  "world.spawn": entry({
    args: z
      .tuple([
        lenient(
          z.object({
            name: lenient(z.string()),
            parent: lenient(z.string()),
            states: lenient(record),
          }),
        ),
      ])
      .rest(z.unknown()),
    capability: "entity.spawn",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "server-revalidate",
    note: "親は自分の配置の Entity だけ（U1）。作った Entity は呼んだ System の配置のものになる。一時的な effect（effects.spawn）とは分ける",
    denied: null,
    params:
      "(desc?: { name?: string; parent?: string; states?: Record<string, Record<string, unknown>> })",
    returns: "string | null",
    doc: "Entity を作って ID を返す。作った Entity は、この System の配置のものになる",
  }),
  "world.destroy": entry({
    args: z.tuple([lenient(z.string())]).rest(z.unknown()),
    capability: "entity.destroy",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "server-revalidate",
    note: "U1 で、自分の配置の中だけにした（別の配置は何も起きない）",
    denied: undefined,
    params: "(entity: string)",
    returns: "void",
    doc: "同じ配置の Entity を消す",
  }),
  "effects.spawn": entry({
    args: z
      .tuple([
        z.string({ error: "Raycast の結果（hit）から出してください" }),
        z.string({ error: "effect の種類（文字列）を渡してください" }),
        lenient(
          z.object({
            color: lenient(z.string()),
            size: lenient(z.number()),
            life: lenient(z.number()),
          }),
        ),
      ])
      .rest(z.unknown()),
    capability: "effects.spawn",
    currentReach: "any-placement",
    crossPlacement: "target-policy",
    authority: "runtime-host",
    note: "U2：Raycast の opaque handle の当たった点にだけ出せる（handle 一つにつき一つ・大きさ 1m・寿命 2 秒・1 フレーム 32 個まで）。保存も物理もしない。別の参加者へ配る分は将来サーバーで quota を検証",
    denied: false,
    params: '(token: string, kind: "spark", opts?: EffectOptions)',
    returns: "boolean",
    doc: "当たった点に一時的な effect を出す（ふつうは hit.effect を使う）",
  }),
  "contract.send": entry({
    args: z
      .tuple([
        z.string({ error: "Raycast の結果（hit）から送ってください" }),
        z.string({ error: "Contract の名前（文字列）を渡してください" }),
        z.unknown(),
      ])
      .rest(z.unknown()),
    capability: "interaction.send",
    currentReach: "any-placement",
    crossPlacement: "public-contract",
    authority: "server-revalidate",
    note: "U2：Raycast で得た opaque handle（一度だけ・1 秒・発行した配置だけ）で、相手が公開した Contract を呼ぶ。相手の公開範囲が interactive のときだけ届く",
    denied: false,
    params: '(token: string, contract: "Damage", payload: { amount: number; type?: string })',
    returns: "boolean",
    doc: "当たった相手が公開した Contract を呼ぶ（ふつうは hit.send を使う）",
  }),
} satisfies Record<HostName, SpecEntry<z.ZodType>>;

/** Raycast の結果のメソッド（Host API を包んだもの）の、利用者向けの型と説明 */
const HIT_METHODS: {
  name: string;
  params: string;
  returns: string;
  doc: string;
  capability: CapabilityId;
  stability?: Stability;
}[] = [
  {
    name: "send",
    params: '(contract: "Damage", payload: { amount: number; type?: string })',
    returns: "boolean",
    doc: "当たった相手が公開した Contract を呼ぶ（一度だけ・1 秒の間だけ）",
    capability: "interaction.send",
  },
  {
    name: "effect",
    params: '(kind: "spark", opts?: EffectOptions)',
    returns: "boolean",
    doc: "当たった点に一時的な effect を出す（一度だけ・1 秒の間だけ）",
    capability: "effects.spawn",
  },
];

const namespaces = () => {
  const out = new Map<string, HostName[]>();
  for (const name of Object.keys(HOST_API_SPEC) as HostName[]) {
    const ns = name.split(".")[0] ?? name;
    out.set(ns, [...(out.get(ns) ?? []), name]);
  }
  return out;
};

/** 利用者向けの型の宣言（.d.ts）。型付き JavaScript（計画 Phase 8）とエディタで使う */
/** 説明の終わりに添える：要る権限と安定度 */
const note = (capability: CapabilityId, stability: Stability = DEFAULT_STABILITY) =>
  `要る権限：${capability}・${stability}`;

export function hostApiDeclarations(): string {
  const lines = [
    "// Host API の宣言（packages/runtime/src/hostApiSpec.ts から作った。手で書き換えない）",
    "type Vec3 = [number, number, number];",
    "/** import した KokoState */",
    "interface KokoState { readonly id: string; readonly name: string }",
    "interface EffectOptions { color?: string; size?: number; life?: number }",
    "/** Raycast の結果（opaque handle）。別の作者の物に当たったときは entity が null */",
    "interface Hit {",
    "  readonly token: string;",
    "  readonly entity: string | null;",
    "  readonly distance: number;",
    "  readonly point: Vec3;",
    ...HIT_METHODS.map(
      (m) =>
        `  /** ${m.doc}（${note(m.capability, m.stability)}） */\n  ${m.name}${m.params}: ${m.returns};`,
    ),
    "}",
  ];
  for (const [ns, names] of namespaces()) {
    lines.push(`declare const ${ns}: {`);
    for (const name of names) {
      const s = HOST_API_SPEC[name];
      lines.push(`  /** ${s.doc}（${note(s.capability, s.stability)}） */`);
      lines.push(`  ${name.split(".")[1]}${s.params}: ${s.returns};`);
    }
    lines.push("};");
  }
  lines.push("declare function system<T>(def: T): T;");
  lines.push("declare function log(...args: unknown[]): void;");
  return `${lines.join("\n")}\n`;
}

export interface HostApiCompletion {
  label: string;
  type: "function";
  detail: string;
  info: string;
}

/** エディタの入力補完：`名前空間.` のあとに出す候補（Raycast の結果は "hit"） */
export function hostApiCompletions(namespace: string): HostApiCompletion[] {
  if (namespace === "hit")
    return HIT_METHODS.map((m) => ({
      label: m.name,
      type: "function",
      detail: `${m.params}: ${m.returns}`,
      info: `${m.doc}（${note(m.capability, m.stability)}）`,
    }));
  return (namespaces().get(namespace) ?? []).map((name) => {
    const s = HOST_API_SPEC[name];
    return {
      label: name.split(".")[1] ?? name,
      type: "function",
      detail: `${s.params}: ${s.returns}`,
      info: `${s.doc}（${note(s.capability, s.stability)}）`,
    };
  });
}
