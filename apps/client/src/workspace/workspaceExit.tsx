import type { WorkspaceInfo } from "@tukurium/shared";
import { useApp } from "../app/store";
import { useMainMenu } from "../main-menu/store";
import { useWorkspace } from "./store";

/** 閉じる前の確認。プロジェクトは残る。 */
export function confirmCloseWorkspace(name: string): boolean {
  return window.confirm(
    `「${name}」を閉じますか？開いている人は出て、このセッションの一覧からなくなります。プロジェクトは残ります。`,
  );
}

function isAdmin(
  members: WorkspaceInfo["members"] | undefined,
  userId: string | undefined,
  role: string | null,
): boolean {
  if (role === "admin") return true;
  return members?.some((m) => m.userId === userId && m.role === "admin") ?? false;
}

/**
 * 開いているワークスペースの「出る」と「閉じる」。
 * 出るは自分だけ。閉じるは管理の人だけで、確認してから一覧からなくす。
 */
export function WorkspaceLeaveClose({
  className,
  closeClassName,
}: {
  className: string | undefined;
  closeClassName?: string;
}) {
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const role = useWorkspace((s) => s.role);
  const pending = useMainMenu((s) => s.editingPending);
  const meId = useApp((s) => s.me?.id);
  const info = useApp((s) => s.session?.workspaces.find((w) => w.id === workspaceId));
  if (!workspaceId) return null;
  const admin = isAdmin(info?.members, meId, role);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={pending}
        title="自分だけ出ます。ワークスペースは残ります"
        aria-label="ワークスペースを出る"
        onClick={() => useWorkspace.getState().leave()}
      >
        出る
      </button>
      {admin && (
        <button
          type="button"
          className={[className, closeClassName].filter(Boolean).join(" ")}
          disabled={pending}
          title="このセッションの一覧からなくします。プロジェクトは残ります"
          aria-label="ワークスペースを閉じる"
          onClick={() => {
            if (confirmCloseWorkspace(info?.name ?? "ワークスペース"))
              useWorkspace.getState().end();
          }}
        >
          閉じる
        </button>
      )}
    </>
  );
}

/**
 * いま入っていないワークスペースを、一覧から閉じる。
 * 入っているものは、出ると閉じるの組で扱う。
 */
export function WorkspaceCloseButton({
  workspaceId,
  name,
  className,
}: {
  workspaceId: string;
  name: string;
  className: string | undefined;
}) {
  const here = useWorkspace((s) => s.workspaceId);
  const meId = useApp((s) => s.me?.id);
  const members = useApp((s) => s.session?.workspaces.find((w) => w.id === workspaceId)?.members);
  if (here === workspaceId) return null;
  if (!isAdmin(members, meId, null)) return null;
  return (
    <button
      type="button"
      className={className}
      aria-label={`${name}を閉じる`}
      title="このセッションの一覧からなくします。プロジェクトは残ります"
      onClick={() => {
        if (confirmCloseWorkspace(name)) useWorkspace.getState().end(workspaceId);
      }}
    >
      閉じる
    </button>
  );
}
