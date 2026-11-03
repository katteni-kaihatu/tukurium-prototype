import { z } from "zod";

/**
 * 公式の Contract（ADR 0011・0012）。Package の仕組み（U3）ができるまでは Built-in として持ち、
 * U3 で公式 Package（@tukurium/interaction など）へ移す。
 * payload は schema で検証してから受ける側へ渡す（余分なキーは拒む）。
 */
export const BUILTIN_CONTRACTS = {
  Damage: {
    version: 1,
    /** 安定度（ADR 0019。今はすべて experimental） */
    stability: "experimental",
    payload: z
      .object({
        amount: z.number().finite().min(0).max(1_000_000),
        type: z.string().max(32).optional(),
      })
      .strict(),
  },
  /**
   * プレイヤーが E（use）で見ている物を押す（ADR 0016）。送れるのは Host だけで、player は Host が
   * 実際の入力から入れる（スクリプトからは送れない。偽の player を名乗れないようにする）。
   */
  Interact: {
    version: 1,
    stability: "experimental",
    payload: z.object({ player: z.string().max(64) }).strict(),
  },
} as const;

/** スクリプトから hit.send で送れない Contract（プレイヤーの操作として Host だけが送る） */
export const HOST_ONLY_CONTRACTS: readonly ContractName[] = ["Interact"];

export type ContractName = keyof typeof BUILTIN_CONTRACTS;

export function isContractName(name: string): name is ContractName {
  return Object.hasOwn(BUILTIN_CONTRACTS, name);
}

/** payload を検証する。失敗したら、利用者向けの文言の TypeError を投げる */
export function parseContractPayload(
  name: ContractName,
  payload: unknown,
): Record<string, unknown> {
  const r = BUILTIN_CONTRACTS[name].payload.safeParse(payload);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "payload";
  throw new TypeError(`${name} の ${where} が正しくありません（${issue?.message ?? ""}）`);
}
