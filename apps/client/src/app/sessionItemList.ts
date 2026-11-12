import type { PlacementInfo, WorkspaceInfo } from "@tukurium/shared";

/** 左の欄の「アイテム」に並べる配置。ワールドとライブラリは含めない。 */
export function listedSessionItems(placements: readonly PlacementInfo[]): PlacementInfo[] {
  return placements.filter(
    (placement) => placement.outputKind !== "world" && placement.outputKind !== "library",
  );
}

/**
 * セッションから外せる人。サーバーと同じく、セッションの持ち主、出した人、
 * そのワークスペースを編集できる人。
 */
export function canPutAway(
  placement: PlacementInfo,
  meId: string | undefined,
  ownerId: string | undefined,
  workspaces: readonly WorkspaceInfo[],
): boolean {
  if (!meId) return false;
  if (meId === ownerId || meId === placement.placedBy) return true;
  if (!placement.workspaceId) return false;
  const workspace = workspaces.find((item) => item.id === placement.workspaceId);
  if (!workspace) return false;
  const role =
    workspace.members.find((member) => member.userId === meId)?.role ?? workspace.defaultRole;
  return role === "editor" || role === "admin";
}

/** 誰が出したか。自分なら「あなた」。 */
export function whoPlaced(
  participants: readonly { id: string; name: string }[],
  placedBy: string,
  meId: string | undefined,
): string {
  if (placedBy === meId) return "あなた";
  return participants.find((person) => person.id === placedBy)?.name ?? "参加者";
}
