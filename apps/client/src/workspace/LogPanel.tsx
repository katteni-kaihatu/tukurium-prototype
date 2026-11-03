import { useProject } from "./hooks";
import styles from "./LogPanel.module.css";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

/**
 * ログ・保存パネル：Play 中のスクリプトの log() とエラー（時系列）、保存の状態。
 * 「問題」（いま残っている診断）とは分ける（計画 §2.4）。
 * 保存は、作業内容がサーバーに自動で残ることの案内と、意図的な保存（保存パネル）への入口。
 * メッセージ付きの保存そのものは保存パネルが担う（main の #28 で独立した）。
 */
export function LogPanel() {
  const ws = useWorkspace();
  const project = useProject();
  const { logs, saveOpen } = ws;
  useWorkspace((s) => s.rev);
  return (
    <>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <h3 className={ui.sectionTitle}>ログ</h3>
          {logs.length > 0 && <span className={ui.badge}>{logs.length}</span>}
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
          作業内容はサーバーに自動保存されています。メッセージを付けて残すときは「保存」から。
        </p>
        <div className={ui.toolbar}>
          <button
            type="button"
            className={ui.btn}
            aria-pressed={saveOpen}
            onClick={() => {
              if (saveOpen) useWorkspace.setState({ saveOpen: false });
              else useWorkspace.getState().openSave();
            }}
          >
            保存パネルを開く
          </button>
        </div>
      </div>
    </>
  );
}
