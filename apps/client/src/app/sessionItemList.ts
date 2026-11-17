import type { PlacementInfo, WorkspaceInfo } from "@tukurium/shared";
import type { RepoMeta } from "../net/api";

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

/** アイテムの元のプロジェクトについて、本人ができること */
export interface ItemProjectActions {
  /** 元のプロジェクト（読めるときだけ） */
  source: RepoMeta | null;
  /** 書き込める（持ち主）ので、そのままワークスペースで開ける */
  canOpen: boolean;
  /** 読めるが書き込めないので、フォークしてから開く */
  canFork: boolean;
  /** 元のプロジェクトから自分がフォークしたプロジェクト */
  forks: RepoMeta[];
}

/**
 * アイテムから開けるプロジェクト。repos は本人が読めるプロジェクトの一覧
 * （サーバーの GET /api/repos）。何もできなければ null。
 */
export function itemProjectActions(
  placement: PlacementInfo,
  repos: readonly RepoMeta[],
  meId: string | undefined,
): ItemProjectActions | null {
  const repoId = placement.repoId;
  if (!repoId || !meId) return null;
  const source = repos.find((repo) => repo.id === repoId) ?? null;
  const forks = repos.filter((repo) => repo.owner === meId && repo.forkedFrom?.repoId === repoId);
  const canOpen = source?.owner === meId;
  const canFork = !!source && !canOpen;
  if (!canOpen && !canFork && forks.length === 0) return null;
  return { source, canOpen, canFork, forks };
}
