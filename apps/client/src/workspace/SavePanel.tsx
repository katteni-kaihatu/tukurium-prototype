import { useState } from "react";
import { ChangeList } from "./ChangeList";
import styles from "./history.module.css";
import ui from "./ui.module.css";
import { useHistory } from "./useHistory";

/**
 * 保存：上にメッセージと保存ボタン、下に未保存の差分を名前で出す。
 * 保存できるのはプロジェクトの持ち主だけ。一緒に編集している人は記録に残る。
 */
export function SavePanel() {
  const { repoId, entries, error, ready, isOwner, names, save } = useHistory();
  const [message, setMessage] = useState("");

  if (!repoId) {
    return <p className={ui.empty}>このワークスペースにはプロジェクトがありません</p>;
  }

  return (
    <div className={styles.save}>
      <div className={styles.saveTop}>
        <label className={styles.fieldLabel} htmlFor="save-message">
          メッセージ
        </label>
        <div className={styles.form}>
          <input
            id="save-message"
            className={ui.input}
            value={message}
            maxLength={500}
            disabled={!isOwner}
            placeholder={isOwner ? "何を変えたか" : "保存できるのはプロジェクトの持ち主です"}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && isOwner && message.trim()) {
                save(message.trim());
                setMessage("");
              }
            }}
          />
          <button
            type="button"
            className={ui.btnPrimary}
            disabled={!isOwner || !message.trim()}
            onClick={() => {
              save(message.trim());
              setMessage("");
            }}
          >
            保存
          </button>
        </div>
        {names.length > 0 && <p className={ui.muted}>一緒に編集: {names.join("、")}</p>}
        {error && <p className={ui.error}>{error}</p>}
      </div>
      <div className={styles.saveDiff}>
        <div className={styles.diffHead}>
          <h3 className={ui.sectionTitle}>差分</h3>
          {ready && (
            <span className={entries.length > 0 ? ui.badgeWarn : ui.badge}>{entries.length}件</span>
          )}
        </div>
        {ready ? <ChangeList entries={entries} /> : <p className={ui.muted}>読み込んでいます…</p>}
      </div>
    </div>
  );
}
