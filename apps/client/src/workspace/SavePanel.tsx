import { useState } from "react";
import { ChangeList, ChangeSide } from "./ChangeList";
import styles from "./history.module.css";
import ui from "./ui.module.css";
import { useHistory } from "./useHistory";
import { useRevert } from "./useRevert";

/**
 * 保存：左の上にメッセージと保存ボタン、下に未保存の差分を名前で出す。
 * 差分を選ぶと、右側の欄にその中身を出す。行にマウスを載せると、元に戻すボタンが出る。
 * 保存できるのはプロジェクトの持ち主だけ。一緒に編集している人は記録に残る。
 */
export function SavePanel() {
  const { repoId, entries, error, ready, isOwner, names, save } = useHistory();
  const [message, setMessage] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const { canRevert, revert } = useRevert();
  const [revertError, setRevertError] = useState<string | null>(null);
  // 一覧は編集のたびに作り直されるので、id で引き直す（消えたら何も選んでいない）
  const pickedEntry = entries.find((e) => e.id === picked) ?? null;

  if (!repoId) {
    return <p className={ui.empty}>このワークスペースにはプロジェクトがありません</p>;
  }

  return (
    <div className={styles.saveOuter}>
      <div className={styles.saveFrame}>
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
            {revertError && <p className={ui.error}>{revertError}</p>}
          </div>
          <div className={styles.saveDiff}>
            <div className={styles.diffHead}>
              <h3 className={ui.sectionTitle}>差分</h3>
              {ready && (
                <span className={entries.length > 0 ? ui.badgeWarn : ui.badge}>
                  {entries.length}件
                </span>
              )}
            </div>
            {ready ? (
              <ChangeList
                entries={entries}
                selected={pickedEntry?.id ?? null}
                onSelect={(id) => {
                  setRevertError(null);
                  setPicked(id);
                }}
                revertable={(entry) => canRevert(entry.id)}
                onRevert={(entry) => setRevertError(revert(entry.id))}
              />
            ) : (
              <p className={ui.muted}>読み込んでいます…</p>
            )}
          </div>
        </div>
        <ChangeSide
          entry={pickedEntry}
          error={revertError}
          revert={
            pickedEntry
              ? {
                  revertable: (part) => canRevert(pickedEntry.id, part),
                  onRevert: (part) => setRevertError(revert(pickedEntry.id, part)),
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}
