import type { PlacementInfo } from "@tukurium/shared";
import type { OwnedItem } from "../net/api";

export interface SessionItemGroups {
  /** いま一覧に見えている所持品 → その版をセッションに出した配置 */
  onCards: Map<string, PlacementInfo[]>;
  /** 一覧のカードに出ていない配置（絞り込みで隠れている所持品、ワークスペースから出したもの） */
  extra: { placement: PlacementInfo; item: OwnedItem | null }[];
}

/** セッションに出ているアイテムを、所持一覧のどこに出すか分ける。ワールドは含めない。 */
export function sessionItemGroups(
  owned: readonly OwnedItem[],
  placements: readonly PlacementInfo[],
  visibleWorkIds: ReadonlySet<string>,
): SessionItemGroups {
  const onCards = new Map<string, PlacementInfo[]>();
  const extra: SessionItemGroups["extra"] = [];
  for (const placement of placements) {
    if (placement.outputKind !== "item") continue;
    const item = placement.releaseId
      ? owned.find((ownedItem) => ownedItem.releaseId === placement.releaseId)
      : undefined;
    if (item && visibleWorkIds.has(item.workId)) {
      const list = onCards.get(item.workId) ?? [];
      list.push(placement);
      onCards.set(item.workId, list);
    } else {
      extra.push({ placement, item: item ?? null });
    }
  }
  return { onCards, extra };
}
