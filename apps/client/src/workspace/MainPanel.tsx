import { emptyProject, gunAndTargetSample } from "@tukurium/repo-model";
import { useState } from "react";
import styles from "./MainPanel.module.css";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

/** 初版では見た目だけ置く機能（計画 §9） */
const LATER = "初版では見た目だけです";

/**
 * ワークスペースのメインパネル：アウトプットの切り替え、再生・一時停止・停止、ログ。
 * 適用（M3）・コミット（M4）・History / Releases / Members（M4・M5）は、該当の段階で動くようにする。
 */
export function MainPanel() {
  const ws = useWorkspace();
  const { project, outputId, mode, logs, systemStatus } = ws;
  useWorkspace((s) => s.rev);
  const [starting, setStarting] = useState(false);
  const outputs = project.outputs();
  const errors = systemStatus.filter((s) => s.error);

  const play = async () => {
    setStarting(true);
    try {
      await ws.play();
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <div className={styles.head}>
        <span className={styles.repo}>
          <span className={styles.owner}>ローカル</span>
          <span className={styles.slash}>/</span>
          <b>{project.name}</b>
        </span>
        <span className={styles.branch}>main</span>
        <span style={{ flex: 1 }} />
        {["Project", "History", "Releases", "Members"].map((label) => (
          <button key={label} type="button" className={ui.btn} disabled title={LATER}>
            {label}
          </button>
        ))}
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
            <option value="__new">＋ アウトプットを追加</option>
          </select>
        </label>

        <div className={styles.transport}>
          {mode === "edit" ? (
            <button type="button" className={ui.btnPrimary} onClick={play} disabled={starting}>
              ▶ {starting ? "準備中…" : "Play"}
            </button>
          ) : mode === "play" ? (
            <button type="button" className={ui.btn} onClick={ws.pause}>
              ❚❚ Pause
            </button>
          ) : (
            <button type="button" className={ui.btnPrimary} onClick={ws.resume}>
              ▶ Resume
            </button>
          )}
          <button type="button" className={ui.btn} onClick={ws.stop} disabled={mode === "edit"}>
            ■ Stop
          </button>
          <button
            type="button"
            className={ui.btn}
            disabled
            title="セッションへの適用は M3 で動くようになります"
          >
            適用
          </button>
        </div>

        <span className={mode === "edit" ? ui.badge : ui.badgeWarn} aria-live="polite">
          {mode === "edit" ? "Edit mode" : mode === "play" ? "Play mode" : "一時停止中"}
        </span>
      </div>

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
            作業内容はこのブラウザに自動保存されています。メッセージ付きのコミットは M4
            で使えるようになります。
          </p>
          <div className={ui.toolbar}>
            <button type="button" className={ui.btn} disabled title={LATER}>
              コミット
            </button>
            <button
              type="button"
              className={ui.btn}
              onClick={() =>
                confirm("いまの内容を捨てて、サンプル「銃と的」を読み込みますか？") &&
                ws.loadSnapshot(gunAndTargetSample())
              }
            >
              サンプル「銃と的」を読み込む
            </button>
            <button
              type="button"
              className={ui.btnDanger}
              onClick={() =>
                confirm("いまの内容を捨てて、空のプロジェクトにしますか？") &&
                ws.loadSnapshot(emptyProject("新しいプロジェクト"))
              }
            >
              空にする
            </button>
          </div>
        </div>
      </details>
    </>
  );
}
