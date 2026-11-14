import type { PrefabInstancePlan } from "@tukurium/repo-model";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePanelPopover } from "../panels/popover";
import { useCanEdit, useProject } from "./hooks";
import styles from "./PrefabFromEntityAsk.module.css";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

export type PrefabInstanceAction = "apply" | "unpack";

/** インスタンスの変更を適用する前、またはつながりを切る前に、変更内容を見せる。 */
export function PrefabInstanceAsk({
  entityId,
  action,
  anchor,
  onClose,
  onDone,
}: {
  entityId: string;
  action: PrefabInstanceAction;
  anchor: HTMLElement;
  onClose: () => void;
  onDone: () => void;
}) {
  const project = useProject();
  const rev = useWorkspace((s) => s.rev);
  const schemas = useWorkspace((s) => s.fieldSchemas);
  const canEdit = useCanEdit();
  const [error, setError] = useState<string | null>(null);
  // 確認中に共同編集で中身が変わっても、表示済みの ID を使い続ける。
  const ids = useRef<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は制作データが変わった合図
  const result = useMemo(() => {
    const options = { schemas, ids: ids.current };
    const made =
      action === "apply"
        ? project.planApplyPrefabInstance(entityId, options)
        : project.planUnpackPrefabInstance(entityId, options);
    if (made.ok) ids.current = { ...ids.current, ...made.plan.ids };
    return made;
  }, [project, rev, schemas, entityId, action]);

  const box = useRef<HTMLDivElement>(null);
  const { container, style } = usePanelPopover(anchor, box, "start", 6);
  useLayoutEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchor.contains(target) || box.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [anchor, onClose]);

  const name = project.findEntity(entityId)?.name ?? "Entity";
  const label = action === "apply" ? "プレハブに適用" : "ふつうの Entity に戻す";
  const plan: PrefabInstancePlan | null = result.ok ? result.plan : null;
  const registry = project.registry();
  const fieldLabel = (koko: string, field: string) => {
    const def = registry.get(koko);
    return `${def?.name ?? koko}.${def?.fields.find((f) => f.id === field)?.name ?? field}`;
  };
  const hasChanges =
    plan !== null &&
    (plan.changes.length > 0 || plan.moved.length > 0 || plan.keepMoved.length > 0);

  const run = () => {
    if (!canEdit) return;
    try {
      setError(null);
      const options = { schemas, ids: ids.current };
      if (action === "apply") project.applyPrefabInstance(entityId, options);
      else project.unpackPrefabInstance(entityId, options);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return createPortal(
    <div
      ref={box}
      className={styles.ask}
      role="dialog"
      aria-label={`${name} を${label}`}
      style={style}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <b className={styles.title}>
        「{name}」を{label}
      </b>
      {!plan ? (
        <p className={ui.error}>{result.ok ? "" : result.reason}</p>
      ) : (
        <>
          <p className={ui.muted}>
            {action === "apply"
              ? "このインスタンスで変えた所をプレハブに書き戻し、ほかのインスタンスにも反映します。適用した上書きは消えます。このインスタンスの名前・親・並び順・場所・向き・大きさは、そのままです。"
              : "いまの中身を残して、このプレハブとのつながりを切ります。あとでプレハブを変えても反映されません。中にある別のプレハブのインスタンスは、そのまま残ります。"}
          </p>

          <section className={styles.part} aria-label="変更する所">
            <h4 className={styles.heading}>変更する所（{plan.changes.length} か所）</h4>
            {plan.changes.length === 0 ? (
              <p className={ui.muted}>
                {action === "apply" ? "適用する上書きはありません。" : "つながりを切ります。"}
              </p>
            ) : (
              <ul className={styles.list}>
                {plan.changes.map((change) => (
                  <li key={`${change.entity}:${change.kind}:${change.detail}`}>
                    <span>「{change.name}」</span>
                    <span>{change.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {plan.moved.length > 0 && (
            <section className={styles.part} aria-label="ID が変わる Entity">
              <h4 className={styles.heading}>ID が変わる Entity（{plan.moved.length} 個）</h4>
              <ul className={styles.list}>
                {plan.moved.map((moved) => (
                  <li key={moved.from}>
                    <span>{moved.name}</span>
                    <code className={styles.ids} title="いまの ID → 変更後の ID">
                      {moved.from} → {action === "apply" ? moved.expanded : moved.to}
                    </code>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.rewrites.length > 0 && (
            <section className={styles.part} aria-label="書き換える参照">
              <h4 className={styles.heading}>書き換える参照（{plan.rewrites.length} か所）</h4>
              <ul className={styles.list}>
                {plan.rewrites.map((rewrite) => (
                  <li
                    key={`${rewrite.entity}:${rewrite.koko}:${rewrite.field}:${rewrite.targets.map((t) => t.from).join(",")}`}
                  >
                    <span>
                      「{rewrite.entityName}」の {fieldLabel(rewrite.koko, rewrite.field)}
                    </span>
                    {rewrite.targets.map((target) => (
                      <code key={target.from} className={styles.ids}>
                        {target.from} → {target.to}
                      </code>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.keepMoved.length > 0 && (
            <section className={styles.part} aria-label="移す維持の印">
              <h4 className={styles.heading}>移す「維持」の印（{plan.keepMoved.length} 個）</h4>
              <ul className={styles.list}>
                {plan.keepMoved.map((mark) => (
                  <li key={`${mark.from.entity}:${mark.from.koko}:${mark.from.field}`}>
                    <span>{fieldLabel(mark.from.koko, mark.from.field)}</span>
                    <code className={styles.ids}>
                      {mark.from.entity} → {mark.to.entity}
                    </code>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.warnings.length > 0 && (
            <section className={styles.part} aria-label="注意点">
              <h4 className={styles.heading}>注意点</h4>
              <ul className={styles.list}>
                {plan.warnings.map((warning) => (
                  <li key={warning} className={ui.notice}>
                    {warning}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {error && <p className={ui.error}>{error}</p>}
      <div className={styles.buttons}>
        <button type="button" className={ui.btn} onClick={onClose}>
          {plan ? "やめる" : "閉じる"}
        </button>
        {plan && (
          <button
            type="button"
            className={ui.btnPrimary}
            disabled={!canEdit || (action === "apply" && !hasChanges)}
            onClick={run}
          >
            {label}
          </button>
        )}
      </div>
    </div>,
    container,
  );
}
