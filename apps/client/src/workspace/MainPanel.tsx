import { useApp } from "../app/store";
import { useProject } from "./hooks";
import styles from "./MainPanel.module.css";
import { SessionLinks } from "./SessionLinks";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

const ROLE_LABEL = { viewer: "閲覧", editor: "共同編集", admin: "管理" } as const;

/**
 * ワークスペースのメインパネル：アウトプットの切り替え、再生・一時停止・停止、ログ。
 * 再生の操作はホスト（再生を実行する人）に届き、全員に同じ状態が配られる。
 * セッションに出す・適用・リンク先一覧は SessionLinks。コミット（M4）・History / Releases（M4）は後の段階で。
 */
export function MainPanel() {
  const ws = useWorkspace();
  const project = useProject();
  const { outputId, mode, logs, systemStatus, role, isHost, workspaceId, historyOpen } = ws;
  useWorkspace((s) => s.rev);
  const info = useApp((s) => s.session?.workspaces.find((w) => w.id === workspaceId));
  const hostName = useApp((s) => s.session?.participants.find((p) => p.id === info?.host)?.name);
  const outputs = project.outputs();
  const errors = systemStatus.filter((s) => s.error);
  const canOperate = role === "editor" || role === "admin";

  return (
    <>
      <div className={styles.head}>
        <span className={styles.repo}>
          <b>{info?.name ?? project.name}</b>
        </span>
        <span className={styles.branch}>main</span>
        {role && (
          <span className={role === "viewer" ? ui.badgeWarn : ui.badgeBrand}>
            {ROLE_LABEL[role]}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {info?.repoId && (
          <a className={ui.btn} href={`/p/${info.repoId}`} target="_blank" rel="noreferrer">
            Project
          </a>
        )}
        <button
          type="button"
          className={ui.btn}
          aria-pressed={historyOpen}
          onClick={() => useWorkspace.setState({ historyOpen: !historyOpen })}
        >
          History
        </button>
        {info?.repoId && (
          <a
            className={ui.btn}
            href={`/p/${info.repoId}`}
            target="_blank"
            rel="noreferrer"
            title="作品の公開とリリースはプロジェクトのページで"
          >
            Releases
          </a>
        )}
      </div>

      <div className={styles.bar}>
        <label className={styles.output}>
          <span className={styles.outputLabel}>
            Output · {project.output(outputId)?.kind === "world" ? "world" : "item"}
          </span>
          <select
            className={ui.select}
            aria-label="アウトプット"
            value={outputId}
            disabled={mode !== "edit"}
            onChange={(e) => {
              if (e.target.value === "__new") {
                const id = project.addOutput(`アウトプット${outputs.length + 1}`, "item");
                ws.setOutput(id);
              } else {
                ws.setOutput(e.target.value);
              }
            }}
          >
            {outputs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            {canOperate && <option value="__new">＋ アウトプットを追加</option>}
          </select>
        </label>

        <div className={styles.transport}>
          {mode === "edit" ? (
            <button
              type="button"
              className={ui.btnPrimary}
              onClick={ws.play}
              disabled={!canOperate || !info?.host}
            >
              ▶ Play
            </button>
          ) : mode === "play" ? (
            <button type="button" className={ui.btn} onClick={ws.pause} disabled={!canOperate}>
              ❚❚ Pause
            </button>
          ) : (
            <button
              type="button"
              className={ui.btnPrimary}
              onClick={ws.resume}
              disabled={!canOperate}
            >
              ▶ Resume
            </button>
          )}
          <button
            type="button"
            className={ui.btn}
            onClick={ws.stop}
            disabled={!canOperate || mode === "edit"}
          >
            ■ Stop
          </button>
        </div>

        <span className={mode === "edit" ? ui.badge : ui.badgeWarn} aria-live="polite">
          {mode === "edit" ? "Edit mode" : mode === "play" ? "Play mode" : "一時停止中"}
        </span>
      </div>
      <p className={`${ui.muted} ${styles.hostLine}`}>
        {info?.host
          ? `再生の実行（ホスト）: ${isHost ? "あなた" : (hostName ?? "?")}`
          : "ホストを務められる人（管理権限）がいないため、再生できません"}
      </p>

      <SessionLinks />

      <details className={styles.details} open={errors.length > 0 || undefined}>
        <summary className={styles.summary}>
          ログ・保存
          {logs.length > 0 && <span className={ui.badge}>{logs.length}</span>}
          {errors.length > 0 && (
            <span className={ui.badgeError}>停止中の System {errors.length}</span>
          )}
        </summary>
        <div className={ui.section}>
          <div className={ui.sectionHead}>
            <h3 className={ui.sectionTitle}>ログ</h3>
            <button
              type="button"
              className={ui.iconBtn}
              aria-label="ログを消す"
              title="ログを消す"
              onClick={ws.clearLogs}
            >
              ✕
            </button>
          </div>
          <ol className={styles.log} aria-label="ログ">
            {logs.length === 0 && (
              <li className={ui.muted}>Play すると、スクリプトの log() やエラーがここに出ます</li>
            )}
            {logs.slice(-40).map((l) => (
              <li key={l.seq} className={l.level === "error" ? styles.logError : undefined}>
                <span className={styles.logTime}>{l.time.toFixed(2)}</span>
                {l.systemId && (
                  <span className={styles.logSys}>
                    {project.system(l.systemId)?.name ?? l.systemId}
                  </span>
                )}
                {l.message}
              </li>
            ))}
          </ol>
        </div>
        <div className={ui.section}>
          <div className={ui.sectionHead}>
            <h3 className={ui.sectionTitle}>保存</h3>
          </div>
          <p className={ui.muted}>
            作業内容はサーバーに自動保存されています。メッセージ付きのコミットは History から。
          </p>
        </div>
      </details>
    </>
  );
}
