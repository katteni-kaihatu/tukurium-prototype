import type { WorkspaceInfo } from "@tukurium/shared";

/** セッションの中での、ワークスペースの編集空間の置き場所 */
export interface WorkspaceAnchor {
  position: [number, number, number];
  /** 独立した空間（非公開の作業・ワールドの編集）。セッションの中ではポータルだけを置く */
  isolated: boolean;
  /** セッションの中の、そのワークスペースの区画（ポータルや「作業中」の表示を置く） */
  slot: [number, number, number];
  /** 独立した空間へ入るポータルの位置（区画の奥） */
  portal: [number, number, number];
}

const SLOT_GAP = 12;
const ISOLATED_X = 500;
const ISOLATED_GAP = 60;

/**
 * - アイテムの編集：セッションの中で、何番目かに応じて横にずらす（ほかの人から作業が見える）
 * - 非公開の作業：セッションから離れた独立した空間（要件 §8「プライベートな作業」）
 * - ワールドの編集：独立した空間にポータルで入る（要件 §6「ワールドの編集」）
 */
export function workspaceAnchor(
  workspaces: readonly WorkspaceInfo[],
  workspaceId: string,
  outputKind: "item" | "world",
): WorkspaceAnchor {
  const index = Math.max(
    workspaces.findIndex((w) => w.id === workspaceId),
    0,
  );
  const slot: [number, number, number] = [index * SLOT_GAP, 0, 0];
  const portal: [number, number, number] = [index * SLOT_GAP, 0, -3];
  const info = workspaces.find((w) => w.id === workspaceId);
  if (info?.defaultRole === null) {
    return { position: [ISOLATED_X + index * ISOLATED_GAP, 0, 0], isolated: true, slot, portal };
  }
  if (outputKind === "world") {
    return { position: [-ISOLATED_X - index * ISOLATED_GAP, 0, 0], isolated: true, slot, portal };
  }
  return { position: slot, isolated: false, slot, portal };
}
