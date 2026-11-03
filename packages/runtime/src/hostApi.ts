import type { z } from "zod";
import { HOST_API_SPEC } from "./hostApiSpec";
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

/** 引数の定義（HOST_API_SPEC から作る） */
export const HOST_API_ARGS = Object.fromEntries(
  Object.entries(HOST_API_SPEC).map(([name, spec]) => [name, spec.args]),
) as { [N in HostName]: (typeof HOST_API_SPEC)[N]["args"] };

export type HostArgs<N extends HostName> = z.infer<(typeof HOST_API_ARGS)[N]>;

/** 引数を検証する。失敗したら、利用者向けの文言の TypeError を投げる */
export function parseHostArgs<N extends HostName>(name: N, args: unknown): HostArgs<N> {
  const r = HOST_API_ARGS[name].safeParse(Array.isArray(args) ? args : []);
  if (r.success) return r.data as HostArgs<N>;
  throw new TypeError(r.error.issues[0]?.message ?? `${name} の引数が正しくありません`);
}
