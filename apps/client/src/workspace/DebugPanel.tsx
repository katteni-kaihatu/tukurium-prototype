import { useState } from "react";
import styles from "./DebugPanel.module.css";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

export function DebugPanel() {
  const ws = useWorkspace();
  const [systemId, setSystemId] = useState("");
  const [line, setLine] = useState(1);
  const debug = ws.debug;
  const settings = debug?.read();
  const canWrite = ws.debugReady && (ws.role === "editor" || ws.role === "admin");
  if (!debug || !settings) return null;
  const chosen = systemId || ws.project?.systems()[0]?.id || "";
  return (
    <div className={styles.panel}>
      <label>
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={!canWrite || ws.mode !== "edit"}
          onChange={(e) => debug.setEnabled(e.target.checked)}
        />{" "}
        デバッグモード
      </label>
      {!settings.enabled ? (
        <p>一時停止の条件 {settings.breakpoints.length} 件。デバッグモードを入れると働きます。</p>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={settings.breakOnError}
              disabled={!canWrite}
              onChange={(e) => debug.setBreakOnError(e.target.checked)}
            />{" "}
            実行中のエラーで一時停止
          </label>
          <h3>一時停止の条件</h3>
          {settings.breakpoints.map((point) => (
            <div key={point.id} className={styles.row}>
              <input
                type="checkbox"
                aria-label="条件を有効にする"
                checked={point.enabled}
                disabled={!canWrite}
                onChange={(e) => debug.update(point.id, { enabled: e.target.checked })}
              />
              <button
                type="button"
                className={ui.btn}
                onClick={() => {
                  ws.openSystem(point.systemId);
                  useWorkspace.setState({
                    jumpTo: {
                      systemId: point.systemId,
                      line: point.line,
                      seq: (ws.jumpTo?.seq ?? 0) + 1,
                    },
                  });
                }}
              >
                {ws.project?.system(point.systemId)?.name ?? point.systemId} {point.line} 行目
                {point.kind === "logpoint" ? "（ログ）" : ""}
              </button>
              <button
                type="button"
                className={ui.btn}
                disabled={!canWrite}
                onClick={() => debug.remove(point.id)}
              >
                削除
              </button>
            </div>
          ))}
          <div className={styles.row}>
            <select
              aria-label="停止するスクリプト"
              value={chosen}
              onChange={(e) => setSystemId(e.target.value)}
            >
              {ws.project?.systems().map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              aria-label="停止する行"
              min={1}
              value={line}
              onChange={(e) => setLine(Number(e.target.value))}
              style={{ width: 65 }}
            />
            <button
              type="button"
              className={ui.btn}
              disabled={!canWrite || !chosen}
              onClick={() => debug.add(chosen, line)}
            >
              条件を足す
            </button>
          </div>
          <p className={ui.muted}>エディタの行番号の横を押しても条件を付け外しできます。</p>
        </>
      )}
    </div>
  );
}
