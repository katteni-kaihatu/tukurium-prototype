import type { HostName } from "./simulation";

/**
 * UGC の権限の型と、今の Host API の棚卸し（計画 UGC U0、ADR 0011〜0013）。
 *
 * ここにあるのは型と表だけで、まだ実行時には強制しない（U1 で Capability gateway を作る）。
 * 新しい Host API を足すときは、必ず HOST_API_POLICY にも分類を足す（テストで検査する）。
 */

/** Capability の ID。`名前空間.操作` で、意味を変えるときは version を上げる */
export type CapabilityId =
  | "time.read"
  | "audio.play"
  | "effects.spawn"
  | "physics.raycast"
  | "interaction.send"
  | "entity.discover"
  | "state.read"
  | "state.write"
  | "entity.spawn"
  | "entity.destroy";

export interface CapabilityRef {
  id: CapabilityId;
  /** 互換性がなくなる変更で上げる（1 始まり） */
  version: number;
}

/** Package の安定 ID（名前を変えても変わらない） */
export type PackageId = string & { readonly __brand: "PackageId" };

/** 公開 Contract（例：Damage v1）。Package の中の名前と major version で識別する */
export interface ContractRef {
  package: PackageId;
  name: string;
  version: number;
}

/**
 * 実行の主体（ADR 0012）。権限の付与・handle・監査・Diagnostic は、この context を主体として使う。
 * 利用者のスクリプトが申告した値ではなく、Runtime が配置と System から組み立てる。
 */
export interface PackageExecutionContext {
  packageInstanceId: string;
  packageId: PackageId;
  resolvedVersion: string;
  contentHash: string;
  systemId: string;
  /** 権限を与える単位（ADR 0012：置いた物ごと） */
  placementId: string;
  /** 権限の境界（ADR 0012：セッションに置いた World ごと） */
  worldInstanceId: string;
}

/**
 * 判定をどこで行えば足りるか（ADR 0012 の authority matrix）。
 * - runtime-host：ホストの Runtime gateway で強制する（正規クライアント上の UGC からは守れる）
 * - server-revalidate：別の持ち主に影響しうるので、サーバーでの再検証が要る
 * - server-execute：サーバーで実行する必要がある
 * 今は協調セッション（ホストを信頼する）に限るため、server-* はまだ実装していない。
 * 「保護済み」と表示しないこと。
 */
export type Authority = "runtime-host" | "server-revalidate" | "server-execute";

export interface HostApiPolicy {
  capability: CapabilityId;
  /**
   * 今の実装で届く範囲（characterization test で固定した動き）。
   * own-placement：呼んだ System の配置の中だけ（U1）。any-placement：別の配置にも届く
   */
  currentReach: "own-placement" | "any-placement";
  /** U1 / U2 での、別の配置への扱い */
  crossPlacement: "deny" | "public-contract" | "target-policy";
  authority: Authority;
  note: string;
}

/** 今の全 Host API の分類（deny-by-default へ移すための棚卸し） */
export const HOST_API_POLICY: Record<HostName, HostApiPolicy> = {
  "time.now": {
    capability: "time.read",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "runtime-host",
    note: "読むだけ。対象を取らない",
  },
  "audio.play": {
    capability: "audio.play",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "runtime-host",
    note: "鳴らす素材は自分の領域のもの。数の上限あり（32）。別の参加者へ配る分は将来サーバーで quota を検証",
  },
  "world.raycast": {
    capability: "physics.raycast",
    currentReach: "any-placement",
    crossPlacement: "target-policy",
    authority: "runtime-host",
    note: "U2：別の配置に当たったときは生の Entity ID を返さず、opaque handle（token）だけを返す。相手が private なら当たらない",
  },
  "world.emit": {
    capability: "interaction.send",
    currentReach: "own-placement",
    crossPlacement: "public-contract",
    authority: "server-revalidate",
    note: "U2 で、同じ配置の中だけにした。別の配置へは contract.send（公開 Contract）で送る",
  },
  "world.find": {
    capability: "entity.discover",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "runtime-host",
    note: "U1 で、自分の配置の中だけを探すようにした（別の配置は「見つからない」）",
  },
  "world.get": {
    capability: "state.read",
    currentReach: "own-placement",
    crossPlacement: "target-policy",
    authority: "runtime-host",
    note: "U1 で、自分の配置の Entity だけにした（同じ領域でも別の配置は「見つからない」）",
  },
  "world.set": {
    capability: "state.write",
    currentReach: "own-placement",
    crossPlacement: "target-policy",
    authority: "server-revalidate",
    note: "別の持ち主の永続状態を変えるものは、サーバーの判定なしに保護済みとしない",
  },
  "world.spawn": {
    capability: "entity.spawn",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "server-revalidate",
    note: "親は自分の配置の Entity だけ（U1）。作った Entity は呼んだ System の配置のものになる。一時的な effect（effects.spawn）とは分ける",
  },
  "contract.send": {
    capability: "interaction.send",
    currentReach: "any-placement",
    crossPlacement: "public-contract",
    authority: "server-revalidate",
    note: "U2：Raycast で得た opaque handle（一度だけ・1 秒・発行した配置だけ）で、相手が公開した Contract を呼ぶ。相手の公開範囲が interactive のときだけ届く",
  },
  "world.destroy": {
    capability: "entity.destroy",
    currentReach: "own-placement",
    crossPlacement: "deny",
    authority: "server-revalidate",
    note: "U1 で、自分の配置の中だけにした（別の配置は何も起きない）",
  },
};

/** 組み込みの入力（grab など）の、主体の扱い */
export const BUILTIN_INPUT_AUTHORITY = {
  player: "server-execute",
  note: "今は入力の player をクライアントの申告どおりに信じる（サーバーも書き換えずに中継する）。接続から本人を決めるのはサーバーの役目",
} as const satisfies { player: Authority; note: string };
