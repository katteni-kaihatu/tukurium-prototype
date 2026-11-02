import { useApp } from "../app/store";
import { useSessionWorld } from "../session/sessionWorld";
import { useProject } from "./hooks";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

/**
 * セッションとのつながり：アウトプットをセッションに出す、適用する、リンク先（配置）の一覧（要件 §7）。
 * 適用は、このワークスペース・アウトプットにリンクしている配置すべてを更新する。
 */
export function SessionLinks() {
  const project = useProject();
  const { workspaceId, outputId, role, placePoint } = useWorkspace();
  useWorkspace((s) => s.rev);
  const { client, session, me } = useApp();
  const logs = useApp((s) => s.sessionLogs);
  const hostReady = useSessionWorld(
    (s) => s.isHost || s.remote !== null || (session?.placements.length ?? 0) === 0,
  );
  const canWrite = role === "editor" || role === "admin";
  const links = (session?.placements ?? []).filter(
    (p) => p.workspaceId === workspaceId && p.outputId === outputId,
  );
  const outputName = project.output(outputId)?.name ?? "";
  if (!workspaceId) return null;

  const place = () => {
    // 視線の先の床の上に、自分と同じ向きで置く
    const at = placePoint?.() ?? { position: [0, 0, 0] as [number, number, number], yaw: 0 };
    client.send({
      t: "place",
      workspaceId,
      outputId,
      snapshot: project.snapshot(),
      position: at.position,
      yaw: at.yaw,
    });
  };

  return (
    <div className={ui.section}>
      <div className={ui.sectionHead}>
        <h3 className={ui.sectionTitle}>セッション</h3>
        <span className={ui.badge}>リンク先 {links.length}</span>
      </div>
      <div className={ui.toolbar}>
        <button type="button" className={ui.btn} disabled={!canWrite} onClick={place}>
          セッションに出す
        </button>
        <button
          type="button"
          className={ui.btnPrimary}
          disabled={!canWrite || links.length === 0}
          title={
            links.length === 0
              ? "まずセッションに出してください"
              : `リンク先 ${links.length} 個を更新します`
          }
          onClick={() =>
            client.send({ t: "apply", workspaceId, outputId, snapshot: project.snapshot() })
          }
        >
          適用
        </button>
      </div>
      {!session?.host && links.length > 0 && (
        <p className={ui.notice}>
          セッションの持ち主がいないため、セッションの世界は止まっています。
        </p>
      )}
      {links.length === 0 ? (
        <p className={ui.muted}>
          「{outputName}
          」はまだセッションに出ていません。出すと、遊んでいる人がいる横で編集を続け、「適用」で反映できます。
        </p>
      ) : (
        <ul className={ui.list} aria-label="リンク先一覧">
          {links.map((p, i) => (
            <li key={p.id} className={ui.item} style={{ cursor: "default" }}>
              <span className={ui.itemName}>
                {p.outputName} #{i + 1}
                <span className={ui.muted}>
                  {" "}
                  · {p.position.map((v) => v.toFixed(1)).join(", ")}
                </span>
              </span>
              <button
                type="button"
                className={ui.btn}
                style={{ height: 26 }}
                disabled={!canWrite && session?.owner !== me?.id}
                onClick={() => client.send({ t: "resetPart", placementId: p.id })}
              >
                リセット
              </button>
              <button
                type="button"
                className={ui.iconBtn}
                aria-label="セッションから外す"
                title="セッションから外す"
                disabled={!canWrite && session?.owner !== me?.id}
                onClick={() => client.send({ t: "unplace", placementId: p.id })}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {!hostReady && <p className={ui.muted}>セッションの世界を受け取っています…</p>}
      {logs.length > 0 && (
        <ol
          className={ui.muted}
          style={{ margin: 0, paddingLeft: 18 }}
          aria-label="セッションのログ"
        >
          {logs.slice(-3).map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 末尾 3 件の表示だけ
            <li key={i} style={l.level === "error" ? { color: "#8a2a2a" } : undefined}>
              {l.message}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
