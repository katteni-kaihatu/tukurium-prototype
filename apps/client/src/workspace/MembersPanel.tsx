import type { WorkspaceRole } from "@tukurium/shared";
import { useApp } from "../app/store";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

const ROLES: { value: WorkspaceRole | ""; label: string }[] = [
  { value: "viewer", label: "閲覧" },
  { value: "editor", label: "共同編集" },
  { value: "admin", label: "管理" },
  { value: "", label: "権限なし" },
];

/**
 * Members：ワークスペースの権限（要件 §8）。管理権限を持つ人だけが変更できる。
 * ホストは固定の役割ではなく、その回の当番（管理権限を持つ人が引き継ぐ）。
 */
export function MembersPanel() {
  const { workspaceId, role } = useWorkspace();
  const { session, client, me } = useApp();
  const info = session?.workspaces.find((w) => w.id === workspaceId);
  if (!info || !workspaceId) return null;
  const isAdmin = role === "admin";
  const roleOf = (userId: string): WorkspaceRole | null =>
    info.members.find((m) => m.userId === userId)?.role ?? info.defaultRole;

  return (
    <>
      <div className={ui.section}>
        <p className={ui.muted}>
          権限はワークスペースに付きます。ホストは固定の役割ではなく、その回の当番です（管理権限を持つ人が引き継ぎます）。
        </p>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="default-role">
            参加者の初期値
          </label>
          <select
            id="default-role"
            className={ui.select}
            value={info.defaultRole ?? ""}
            disabled={!isAdmin}
            onChange={(e) =>
              client.send({
                t: "ws.setDefaultRole",
                workspaceId,
                role: (e.target.value || null) as WorkspaceRole | null,
              })
            }
          >
            <option value="editor">共同編集</option>
            <option value="viewer">閲覧</option>
            <option value="">非公開（招待した人だけ）</option>
          </select>
        </div>
      </div>
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>セッションの参加者</h3>
        <ul className={ui.list}>
          {(session?.participants ?? []).map((p) => {
            const r = roleOf(p.id);
            return (
              <li key={p.id} className={ui.item} style={{ cursor: "default" }}>
                <span className={ui.itemName}>
                  {p.name}
                  {p.id === me?.id && "（あなた）"}
                </span>
                {info.host === p.id && <span className={ui.badgeWarn}>ホスト</span>}
                {info.present.includes(p.id) && <span className={ui.badge}>開いている</span>}
                <select
                  className={ui.select}
                  style={{ width: 110 }}
                  aria-label={`${p.name} の権限`}
                  value={r ?? ""}
                  disabled={!isAdmin}
                  onChange={(e) =>
                    client.send({
                      t: "ws.setRole",
                      workspaceId,
                      userId: p.id,
                      role: (e.target.value || null) as WorkspaceRole | null,
                    })
                  }
                >
                  {ROLES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
        {!isAdmin && <p className={ui.muted}>権限を変えられるのは、管理権限を持つ人です。</p>}
      </div>
    </>
  );
}
