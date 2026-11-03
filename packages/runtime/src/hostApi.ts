import { z } from "zod";
import type { HostName } from "./simulation";

/**
 * Host API の引数の定義（schema-first。計画 UGC U1）。QuickJS から届いた値は `unknown` として
 * ここで検証してから使う。検証に失敗したら、スクリプトのエラー（TypeError）にする。
 *
 * これまでの動きを変えないよう、今まで黙って無視していた引数は `.catch()` で
 * 「無いもの」として扱う。今まで例外にしていた引数（座標・Entity の ID・イベント名）は例外にする。
 */

/** Host API の版。引数や結果の形を互換性なく変えるときに上げる */
export const HOST_API_VERSION = 1;

const vec3 = z.tuple([z.number(), z.number(), z.number()], {
  error: "[x, y, z] の形の数値の配列を渡してください",
});
const entityId = z.string({ error: "Entity の ID（文字列）を渡してください" });
/** 無効なら「無いもの」として扱う */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const record = z.record(z.string(), z.unknown());

export const HOST_API_ARGS = {
  "time.now": z.tuple([]).rest(z.unknown()),
  "audio.play": z
    .tuple([lenient(z.string()), lenient(z.string()), lenient(z.number())])
    .rest(z.unknown()),
  "world.raycast": z
    .tuple([
      vec3,
      vec3,
      lenient(z.number()),
      lenient(z.object({ exclude: lenient(z.array(z.string())) })),
    ])
    .rest(z.unknown()),
  "world.emit": z
    .tuple([entityId, z.string({ error: "イベント名（文字列）を渡してください" }), z.unknown()])
    .rest(z.unknown()),
  "world.find": z.tuple([lenient(z.string())]).rest(z.unknown()),
  "world.get": z.tuple([lenient(z.string()), lenient(z.string())]).rest(z.unknown()),
  "world.set": z
    .tuple([lenient(z.string()), lenient(z.string()), lenient(record)])
    .rest(z.unknown()),
  "world.spawn": z
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
  "world.destroy": z.tuple([lenient(z.string())]).rest(z.unknown()),
  "contract.send": z
    .tuple([
      z.string({ error: "Raycast の結果（hit）から送ってください" }),
      z.string({ error: "Contract の名前（文字列）を渡してください" }),
      z.unknown(),
    ])
    .rest(z.unknown()),
} satisfies Record<HostName, z.ZodType>;

export type HostArgs<N extends HostName> = z.infer<(typeof HOST_API_ARGS)[N]>;

/** 引数を検証する。失敗したら、利用者向けの文言の TypeError を投げる */
export function parseHostArgs<N extends HostName>(name: N, args: unknown): HostArgs<N> {
  const r = HOST_API_ARGS[name].safeParse(Array.isArray(args) ? args : []);
  if (r.success) return r.data as HostArgs<N>;
  throw new TypeError(r.error.issues[0]?.message ?? `${name} の引数が正しくありません`);
}
