import type { CapabilityId } from "@tukurium/repo-model";
import { HOST_API_SPEC } from "./hostApiSpec";
import type { HostName } from "./simulation";

export type { CapabilityId };

/**
 * UGC の権限の型と、今の Host API の棚卸し（計画 UGC U0、ADR 0011〜0013）。
 *
 * U1 / U2 で Host API の schema 検証、配置の既定境界、opaque handle、公開 Contract を実行時に強制するようにした。
 * 要る Capability はコードから読み取り（inferCapabilities）、セッションでは「宣言 ∩ 置いた物への付与」で
 * 強制する（Simulation.callHost）。Host API と Capability の対応は repo-model の HOST_CAPABILITIES と一致させる。
 * server-revalidate / server-execute の操作も協調セッション向けで、Server authority は未実装。
 * 新しい Host API を足すときは、必ず HOST_API_POLICY にも分類を足す（テストで検査する）。
 */

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

/** 今の全 Host API の分類（HOST_API_SPEC から作る） */
export const HOST_API_POLICY: Record<HostName, HostApiPolicy> = Object.fromEntries(
  Object.entries(HOST_API_SPEC).map(([name, s]) => [
    name,
    {
      capability: s.capability,
      currentReach: s.currentReach,
      crossPlacement: s.crossPlacement,
      authority: s.authority,
      note: s.note,
    },
  ]),
) as Record<HostName, HostApiPolicy>;

/** 組み込みの入力（grab など）の、主体の扱い */
export const BUILTIN_INPUT_AUTHORITY = {
  player: "server-execute",
  note: "今は入力の player をクライアントの申告どおりに信じる（サーバーも書き換えずに中継する）。接続から本人を決めるのはサーバーの役目",
} as const satisfies { player: Authority; note: string };
