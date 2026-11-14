import { type PrefabFromEntityPlan, packageSystems } from "@tukurium/repo-model";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePanelPopover } from "../panels/popover";
import { useProject } from "./hooks";
import styles from "./PrefabFromEntityAsk.module.css";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

/**
 * 「プレハブにする」の確認（ADR 0076 の 10）。変換の前に、プレハブに移る Entity・書き換える参照と
 * 「維持」の印・スクリプトが ID で探している所を見せる。進めると、一つの操作で変換する。
 * ボタンの下に重ねて出す（2D では画面の上、3D に置いたパネルではそのパネルの上）。
 */
export function PrefabFromEntityAsk({
  entityId,
  anchor,
  onClose,
  onDone,
}: {
  entityId: string;
  anchor: HTMLElement;
  onClose: () => void;
  /** 変換したあと（選んだ Entity は、同じ ID のままインスタンスになっている） */
  onDone: (plan: PrefabFromEntityPlan) => void;
}) {
  const project = useProject();
  const rev = useWorkspace((s) => s.rev);
  const schemas = useWorkspace((s) => s.fieldSchemas);
  const packages = useWorkspace((s) => s.packages);
  const [systems, setSystems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 確認に出した ID のまま変換する（開いている間に制作データが変わって計画を作り直しても、ID は変えない）
  const ids = useRef<{ prefab?: string; entities: Record<string, string> }>({ entities: {} });
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は中身が変わった合図
  const result = useMemo(() => {
    const made = project.planPrefabFromEntity(entityId, { schemas, systems, ids: ids.current });
    if (made.ok)
      ids.current = {
        prefab: made.plan.prefab.id,
        entities: {
          ...ids.current.entities,
          ...Object.fromEntries(made.plan.moved.map((m) => [m.from, m.to])),
        },
      };
    return made;
  }, [project, rev, schemas, systems, entityId]);

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

  const name = project.entity(entityId)?.name ?? "Entity";
  const plan = result.ok ? result.plan : null;
  const output = plan ? project.output(plan.output) : undefined;
  const systemNames = new Map<string, string>([
    ...project.systems().map((s) => [s.id, s.name] as const),
    ...packageSystems(packages.values()).map((s) => [s.id, `@${s.alias}/${s.name}`] as const),
  ]);
  const registry = project.registry();
  const fieldLabel = (koko: string, field: string) => {
    const def = registry.get(koko);
    return `${def?.name ?? koko}.${def?.fields.find((f) => f.id === field)?.name ?? field}`;
  };
  const movedName = (id: string) =>
    plan?.moved.find((m) => id === m.from || id.startsWith(`${m.from}/`))?.name ?? id;

  const run = () => {
    try {
      setError(null);
      onDone(project.makePrefabFromEntity(entityId, { schemas, systems, ids: ids.current }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return createPortal(
    <div
      ref={box}
      className={styles.ask}
      role="dialog"
      aria-label={`${name} をプレハブにする`}
      style={style}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <b className={styles.title}>「{name}」をプレハブにする</b>
      {!plan ? (
        <p className={ui.error}>{result.ok ? "" : result.reason}</p>
      ) : (
        <>
          <p className={ui.muted}>
            プレハブ「{plan.prefab.name}」を作り、この Entity
            を、そのインスタンスにします。ID・名前・親・場所はそのままです。中身は、新しい ID
            を付けてプレハブに移します。
          </p>

          <section className={styles.part} aria-label="プレハブに移る Entity">
            <h4 className={styles.heading}>プレハブに移る Entity（{plan.moved.length} 個）</h4>
            <ul className={styles.list}>
              {plan.moved.map((m) => (
                <li key={m.from} style={{ paddingLeft: m.depth * 12 }}>
                  <span>{m.name}</span>
                  <code className={styles.ids} title="元の ID → プレハブの中の ID">
                    {m.from} → {m.to}
                  </code>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.part} aria-label="書き換える参照">
            <h4 className={styles.heading}>書き換える参照（{plan.rewrites.length} か所）</h4>
            {plan.rewrites.length === 0 ? (
              <p className={ui.muted}>
                ほかの Entity から、中の Entity を指している所はありません。
              </p>
            ) : (
              <>
                <ul className={styles.list}>
                  {plan.rewrites.map((r) => (
                    <li key={`${r.entity}:${r.koko}:${r.field}`}>
                      <span>
                        「{r.entityName}」の {r.kokoName}.{r.fieldName}
                        {r.owner.kind === "prefab" ? "（プレハブの中）" : ""}
                      </span>
                      <span className={styles.to}>
                        → {r.targets.map((t) => movedName(t.from)).join("、")}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className={ui.muted}>
                  指す先を、インスタンスの中の Entity の ID に書き換えます（切れません）。
                </p>
              </>
            )}
          </section>

          {plan.keepMoved.length > 0 && (
            <section className={styles.part} aria-label="「維持」の印">
              <h4 className={styles.heading}>
                プレハブに移す「維持」の印（{plan.keepMoved.length} 個）
              </h4>
              <ul className={styles.list}>
                {plan.keepMoved.map((k) => (
                  <li key={`${k.from.entity}:${k.from.koko}:${k.from.field}`}>
                    <span>
                      「{k.entityName}」の {fieldLabel(k.from.koko, k.from.field)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className={ui.muted}>
                あとで置くインスタンスにも効きます。
                {plan.keepMoved.some((k) => k.from.entity !== plan.entity) &&
                  "中の Entity は ID が変わるので、セッションに出してある配置では、次の「適用」のとき一度だけ、いまの値を引き継ぎません。"}
              </p>
            </section>
          )}

          {plan.scriptMentions.length > 0 && (
            <section className={styles.part} aria-label="スクリプトが ID で探している Entity">
              <h4 className={styles.heading}>スクリプトが ID で探している Entity</h4>
              <p className={ui.notice}>
                次の System のコードに、ID が変わる Entity の ID
                が書いてあります。スクリプトは書き換えないので、変換のあとに直してください。
              </p>
              <ul className={styles.list}>
                {plan.scriptMentions.map((s) => (
                  <li key={s.system}>
                    <span>{s.name}</span>
                    {s.entities.map((e) => (
                      <code key={e.id} className={styles.ids} title="いまの ID → 変換のあとの ID">
                        {e.name}：{e.id} → {e.expanded}
                      </code>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.outsideRefs.length > 0 && (
            <section className={styles.part} aria-label="プレハブの外を指す参照">
              <h4 className={styles.heading}>
                プレハブの外を指す参照（{plan.outsideRefs.length} か所）
              </h4>
              <ul className={styles.list}>
                {plan.outsideRefs.map((r) => (
                  <li key={`${r.entity}:${r.kokoName}:${r.fieldName}:${r.target}`}>
                    <span>
                      「{r.entityName}」の {r.kokoName}.{r.fieldName}
                    </span>
                    <span className={styles.to}>→ {r.targetName}</span>
                  </li>
                ))}
              </ul>
              <p className={ui.muted}>
                そのまま残します。ほかのアウトプットに置いたインスタンスでは、指す先がありません。
              </p>
            </section>
          )}

          {output && output.systems.length > 0 && (
            <section className={styles.part} aria-label="プレハブにも入れる System">
              <h4 className={styles.heading}>プレハブにも入れる System</h4>
              <ul className={styles.list}>
                {output.systems.map((s) => (
                  <li key={s.id}>
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        checked={systems.includes(s.id)}
                        onChange={(e) =>
                          setSystems((cur) =>
                            e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id),
                          )
                        }
                      />
                      <span>{systemNames.get(s.id) ?? s.id}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className={ui.muted}>
                入れた System
                は、このプレハブのインスタンスを置いたアウトプットで動きます。今のアウトプットの並びにも残すので、動き方は変わりません。あとから、プレハブの詳細でも足せます。
              </p>
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
          <button type="button" className={ui.btnPrimary} onClick={run}>
            プレハブにする
          </button>
        )}
      </div>
    </div>,
    container,
  );
}

/** プレハブにする（箱に、上向きの矢印） */
export function MakePrefabIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M2.5 6.5v6a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-6M8 10V2M5 4.8 8 2l3 2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
