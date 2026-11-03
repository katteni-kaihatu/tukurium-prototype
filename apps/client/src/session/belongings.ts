import type { PlacementInfo, WorkspaceRole } from "@tukurium/shared";

/** 権限の判定に使う、セッション台帳の一部 */
export interface BelongingSession {
  owner: string;
  workspaces: {
    id: string;
    defaultRole: WorkspaceRole | null;
    members: { userId: string; role: WorkspaceRole }[];
  }[];
}

/** 一覧の 1 行。セッションに置いてあるもの（ワークスペースの編集中の中身ではない） */
export interface BelongingRow {
  id: string;
  /** アウトプットの名前。同じものを複数置いたときは #1, #2 */
  title: string;
  /** 出した元。公開された作品か、ワークスペースの名前 */
  from: string;
  published: boolean;
  /** セッション上の位置（x, y, z） */
  position: string;
  /** 置いた人の表示名 */
  by: string;
  /** 外す・リセットできるか（サーバーの判定と同じ） */
  canManage: boolean;
}

const groupKey = (p: Pick<PlacementInfo, "workspaceId" | "releaseId" | "outputId">): string =>
  `${p.workspaceId ?? ""}:${p.releaseId ?? ""}:${p.outputId}`;

/**
 * セッションに置いてあるものを、台帳の順に並べる。
 * 同じアウトプットを何度も置いたときだけ、名前のうしろに番号を付ける。
 */
export function listBelongings(
  placements: PlacementInfo[],
  session: BelongingSession,
  meId: string | null,
  names: ReadonlyMap<string, string>,
): BelongingRow[] {
  const totals = new Map<string, number>();
  for (const p of placements) totals.set(groupKey(p), (totals.get(groupKey(p)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return placements.map((p) => {
    const key = groupKey(p);
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    const total = totals.get(key) ?? 1;
    return {
      id: p.id,
      title: total > 1 ? `${p.outputName} #${index}` : p.outputName,
      from: p.releaseId ? `公開された作品 · ${p.workspaceName}` : p.workspaceName,
      published: p.releaseId !== null,
      position: p.position.map((v) => v.toFixed(1)).join(", "),
      by: meId !== null && p.placedBy === meId ? "あなた" : (names.get(p.placedBy) ?? "不明"),
      canManage: meId !== null && canManagePlacement(p, session, meId),
    };
  });
}

/**
 * 外す・リセットできる人。サーバーと同じ：
 * セッションの持ち主、置いた人、元のワークスペースの共同編集者か管理者。
 * 公開された作品（ワークスペースに紐づかない）は、持ち主と置いた人だけ。
 */
export function canManagePlacement(
  placement: Pick<PlacementInfo, "workspaceId" | "placedBy">,
  session: BelongingSession,
  meId: string,
): boolean {
  if (session.owner === meId || placement.placedBy === meId) return true;
  if (!placement.workspaceId) return false;
  const workspace = session.workspaces.find((w) => w.id === placement.workspaceId);
  if (!workspace) return false;
  const role = workspace.members.find((m) => m.userId === meId)?.role ?? workspace.defaultRole;
  return role === "editor" || role === "admin";
}
