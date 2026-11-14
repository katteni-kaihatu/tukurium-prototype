import { decodeValue, encodeValue, stringifyValue, type Value } from "@tukurium/eks";
import { compileDebugExpression } from "@tukurium/repo-model";
import { useState } from "react";
import { openRing } from "../session/ringMenuModel";
import styles from "./DebugPanel.module.css";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { TextValueInput } from "./ValueInput";

export function DebugPanel() {
  const ws = useWorkspace();
  const [systemId, setSystemId] = useState("");
  const [line, setLine] = useState(1);
  const debug = ws.debug;
  const settings = debug?.read();
  const canWrite = ws.debugReady && (ws.role === "editor" || ws.role === "admin");
  if (!debug || !settings) return null;
  const chosen = systemId || ws.project?.systems()[0]?.id || "";
  const stop = ws.debugStop;
  const frame = stop?.frames.find((f) => f.id === ws.debugFrameId) ?? stop?.frames.at(-1);
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
          {settings.breakOnError && (
            <fieldset>
              <legend>エラーの絞り込み</legend>
              <label>
                Entity
                <input
                  aria-label="エラーのEntity"
                  value={settings.errorEntity ?? ""}
                  disabled={!canWrite}
                  placeholder="空欄ならすべて"
                  onChange={(e) => debug.setErrorFilter({ entity: e.target.value })}
                />
              </label>
              <ExpressionInput
                label="エラーの条件式"
                value={settings.errorCondition ?? ""}
                disabled={!canWrite}
                onChange={(condition) => debug.setErrorFilter({ condition })}
              />
            </fieldset>
          )}
          <h3>一時停止の条件</h3>
          {ws.debugStop && (
            <section aria-label="一時停止した場所">
              <p>
                {ws.debugStop.reason}：
                {ws.debugStop.line > 0 && (
                  <>
                    {ws.project?.system(ws.debugStop.systemId)?.name ?? ws.debugStop.systemId}{" "}
                    {ws.debugStop.line} 行目
                  </>
                )}
              </p>
              <button
                type="button"
                className={ui.btnPrimary}
                disabled={!canWrite}
                onClick={() => ws.debugCommand("continue")}
              >
                続ける
              </button>
              <div className={styles.row}>
                <button
                  type="button"
                  className={ui.btn}
                  disabled={!canWrite}
                  onClick={() => ws.debugCommand("over")}
                >
                  次の行へ
                </button>
                <button
                  type="button"
                  className={ui.btn}
                  disabled={!canWrite}
                  onClick={() => ws.debugCommand("into")}
                >
                  関数の中へ
                </button>
                <button
                  type="button"
                  className={ui.btn}
                  disabled={!canWrite}
                  onClick={() => ws.debugCommand("out")}
                >
                  関数から出る
                </button>
                <button
                  type="button"
                  className={ui.btn}
                  disabled={!canWrite}
                  onClick={() => ws.debugCommand("frame")}
                >
                  次のフレームまで
                </button>
              </div>
              {stop?.message && <p role="alert">{stop.message}</p>}
              {stop?.change && (
                <p>
                  {stop.change.source}：{stop.change.field}{" "}
                  {stringifyValue(decodeValue(stop.change.oldValue) as Value)} →{" "}
                  {stringifyValue(decodeValue(stop.change.newValue) as Value)}
                </p>
              )}
              <h3>呼び出しの順</h3>
              <button
                type="button"
                className={ui.btn}
                disabled={!stop?.systemId}
                onClick={() => {
                  if (!stop) return;
                  const systemId = frame?.systemId ?? stop.systemId;
                  ws.openSystem(systemId);
                  useWorkspace.setState({
                    jumpTo: {
                      systemId,
                      line: frame?.line ?? stop.line,
                      seq: (ws.jumpTo?.seq ?? 0) + 1,
                    },
                  });
                }}
              >
                コードを開く
              </button>
              <div className={styles.row}>
                {stop?.frames.map((f) => (
                  <button
                    type="button"
                    key={f.id}
                    className={ui.btn}
                    aria-pressed={frame?.id === f.id}
                    onClick={() => {
                      const systemId = f.systemId ?? stop.systemId;
                      ws.openSystem(systemId);
                      useWorkspace.setState({
                        debugFrameId: f.id,
                        jumpTo: { systemId, line: f.line, seq: (ws.jumpTo?.seq ?? 0) + 1 },
                      });
                    }}
                  >
                    {f.name} {f.line} 行目
                  </button>
                ))}
              </div>
              <h3>変数・引数</h3>
              <p className={ui.muted}>変更した値は、続けると実行中のスクリプトに反映します。</p>
              {frame?.variables.map((v) => (
                <label
                  key={v.name}
                  className={styles.value}
                  htmlFor={`debug-${frame.id}-${v.name}`}
                >
                  <span>
                    {v.name}
                    {v.unavailable
                      ? "（この位置では読めません）"
                      : !v.writable
                        ? "（読み取り）"
                        : ""}
                  </span>
                  <TextValueInput
                    id={`debug-${frame.id}-${v.name}`}
                    label={v.name}
                    value={decodeValue(v.value) as Value}
                    disabled={!canWrite || !v.writable || v.unavailable}
                    onChange={(value) =>
                      ws.debugEdit({ frameId: frame.id, name: v.name, value: encodeValue(value) })
                    }
                  />
                </label>
              ))}
              <h3>
                KokoState：
                {stop?.entity ? (ws.runtime()?.nameOf(stop.entity) ?? stop.entity) : "なし"}
              </h3>
              {stop?.states?.map((state) => (
                <details key={state.id}>
                  <summary>{state.name}</summary>
                  {state.fields.map((field) => (
                    <label
                      key={field.id}
                      className={styles.value}
                      htmlFor={`debug-state-${state.id}-${field.id}`}
                      onContextMenu={(e) => {
                        if (!canWrite || !stop?.entity) return;
                        e.preventDefault();
                        e.stopPropagation();
                        openRing([
                          {
                            id: "debug-watch",
                            label: "変わったら一時停止する",
                            enabled: true,
                            run: () =>
                              debug.setWatch({
                                id: crypto.randomUUID(),
                                enabled: true,
                                entity: stop.entity!,
                                koko: state.id,
                                field: field.id,
                                condition: "",
                              }),
                          },
                        ]);
                      }}
                    >
                      <span>{field.name}</span>
                      <TextValueInput
                        id={`debug-state-${state.id}-${field.id}`}
                        label={`${state.name}.${field.name}`}
                        value={decodeValue(field.value) as Value}
                        disabled={!canWrite}
                        onChange={(value) => {
                          if (stop.entity)
                            ws.debugEdit({
                              kind: "state",
                              entity: stop.entity,
                              koko: state.id,
                              field: field.id,
                              value: encodeValue(value),
                            });
                        }}
                      />
                    </label>
                  ))}
                </details>
              ))}
            </section>
          )}
          {settings.breakpoints.map((point) => (
            <fieldset
              key={point.id}
              onFocus={() => useWorkspace.setState({ debugPointId: point.id })}
            >
              <legend>{ws.debugPointId === point.id ? "選択中の条件" : "条件"}</legend>
              <div className={styles.row}>
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
                    useWorkspace.setState({ debugPointId: point.id });
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
              <label>
                動作{" "}
                <select
                  aria-label="条件の動作"
                  disabled={!canWrite}
                  value={point.kind}
                  onChange={(e) =>
                    debug.update(point.id, { kind: e.target.value as "breakpoint" | "logpoint" })
                  }
                >
                  <option value="breakpoint">一時停止</option>
                  <option value="logpoint">ログだけ出す</option>
                </select>
              </label>
              <label>
                Entity{" "}
                <input
                  aria-label="条件のEntity"
                  disabled={!canWrite}
                  placeholder="空欄ならすべて"
                  value={point.entity}
                  onChange={(e) => debug.update(point.id, { entity: e.target.value })}
                />
              </label>
              <ExpressionInput
                label="条件式"
                value={point.condition}
                disabled={!canWrite}
                onChange={(condition) => debug.update(point.id, { condition })}
              />
              {point.kind === "logpoint" && (
                <ExpressionInput
                  label="ログに出す式"
                  value={point.expression}
                  disabled={!canWrite}
                  onChange={(expression) => debug.update(point.id, { expression })}
                />
              )}
            </fieldset>
          ))}
          {settings.watches.map((w) => (
            <fieldset key={w.id}>
              <legend>フィールドの変化</legend>
              <label>
                <input
                  type="checkbox"
                  checked={w.enabled}
                  disabled={!canWrite}
                  onChange={(e) => debug.setWatch({ ...w, enabled: e.target.checked })}
                />
                {ws.runtime()?.nameOf(w.entity) ?? w.entity} /{" "}
                {ws.project?.kokostate(w.koko)?.name ?? w.koko} / {w.field}
              </label>
              <ExpressionInput
                label="変化の条件式"
                value={w.condition ?? ""}
                disabled={!canWrite}
                onChange={(condition) => debug.setWatch({ ...w, condition })}
              />
              <small>oldValue（前の値）と newValue（新しい値）が使えます。</small>
              <button
                type="button"
                className={ui.btn}
                disabled={!canWrite}
                onClick={() => debug.removeWatch(w.id)}
              >
                監視を削除
              </button>
            </fieldset>
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
              onClick={() => useWorkspace.setState({ debugPointId: debug.add(chosen, line) })}
            >
              条件を足す
            </button>
          </div>
          <p className={ui.muted}>
            式では、代入・関数呼び出し・オブジェクト同士の同一性比較はできません。
            行番号の横を左クリックで一時停止、右クリックでログを追加します。条件を選んでから Entity
            を右クリックすると絞り込めます。設定の変更は次のフレームから反映します。
          </p>
        </>
      )}
    </div>
  );
}

function ExpressionInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  let error = "";
  try {
    if (value.trim()) compileDebugExpression(value);
  } catch (e) {
    error = String(e);
  }
  return (
    <label>
      {label}
      <input
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
