import type { KokoStateDef } from "@tukurium/eks";
import { useState } from "react";
import { useEditTarget, useProject } from "./hooks";
import styles from "./KokoPickerPanel.module.css";
import { catalogEntries, catalogTags, filterCatalog, roleLabel } from "./kokoCatalog";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { packageAliasOf } from "./useProblems";

type View = "table" | "card";
const VIEWS: { id: View; label: string }[] = [
  { id: "table", label: "表" },
  { id: "card", label: "カード" },
];
const VIEW_KEY = "tukurium.kokoPicker.view";

/** 表示の形は人ごとに覚える（既定は表） */
const loadView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === "card" ? "card" : "table";
  } catch {
    return "table";
  }
};

/**
 * KokoState を付ける付属パネル（ADR 0042・0044）。検索欄・件数付きのタグ（出どころ・役割）で絞り、
 * 表かカードで選ぶ。付ける先は、いま選んでいる Entity。付けても閉じず、続けて付けられる。
 */
export function KokoPickerPanel() {
  const entityId = useWorkspace((s) => (s.selection?.kind === "entity" ? s.selection.id : null));
  const project = useProject();
  const target = useEditTarget();
  useWorkspace((s) => s.rev);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [view, setViewState] = useState<View>(loadView);
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // 覚えられなくても表示はできる
    }
  };
  // アウトプットの Entity か、開いているプレハブの中の Entity
  const entity = entityId ? target.snapshot.entities.find((e) => e.id === entityId) : undefined;
  if (!entityId || !entity)
    return (
      <p className={ui.empty}>Hierarchy で Entity を選ぶと、ここから KokoState を付けられます</p>
    );
  const attached = new Set(Object.keys(entity.states));
  const entries = catalogEntries(
    project
      .registry()
      .all()
      .filter((d: KokoStateDef) => !attached.has(d.id)),
    (d) => packageAliasOf(project, d.id),
  );
  const shown = filterCatalog(entries, q, selected);
  const tags = catalogTags(entries, q, selected);
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pick = (kokoId: string) => {
    try {
      setError(null);
      project.addState(entityId, kokoId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={styles.root}>
      <p className={ui.muted}>
        「{entity.name}」に付けます。付けたあとも開いたままなので、続けて付けられます。
      </p>
      <div className={styles.searchRow}>
        <input
          className={styles.search}
          type="search"
          placeholder="名前・フィールド名でさがす"
          aria-label="KokoState を検索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          // biome-ignore lint/a11y/noAutofocus: 開いた直後に検索できるようにする
          autoFocus
        />
        <fieldset className={styles.views} aria-label="表示形式">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={styles.viewBtn}
              aria-label={v.label}
              title={v.label}
              aria-pressed={view === v.id}
              onClick={() => setView(v.id)}
            >
              <ViewIcon view={v.id} />
            </button>
          ))}
        </fieldset>
      </div>
      {(["source", "role"] as const).map((group) => (
        <fieldset key={group} className={styles.tags}>
          <legend className={styles.tagGroup}>{group === "source" ? "出どころ" : "役割"}</legend>
          {tags
            .filter((t) => t.group === group)
            .map((t) => (
              <button
                key={t.id}
                type="button"
                className={styles.tag}
                aria-pressed={selected.has(t.id)}
                onClick={() => toggle(t.id)}
              >
                {t.label}
                <span className={styles.count}>{t.count}</span>
              </button>
            ))}
        </fieldset>
      ))}
      {error && <p className={ui.error}>{error}</p>}
      {view === "table" && (
        <section className={styles.table} aria-label="KokoState の一覧">
          <div className={styles.tableHead} aria-hidden="true">
            <span>Name</span>
            <span>出どころ</span>
            <span>役割</span>
            <span>Fields</span>
          </div>
          {shown.map((e) => (
            <button
              key={e.def.id}
              type="button"
              className={styles.tableRow}
              aria-label={e.def.name}
              title={fieldsText(e.def)}
              onClick={() => pick(e.def.id)}
            >
              <span className={styles.cellName}>
                <span className={styles.smallIcon} aria-hidden="true">
                  <KokoIcon size={14} />
                </span>
                <span className={styles.rowName}>{e.def.name}</span>
              </span>
              <span>
                {e.def.builtin ? "Built-in" : e.alias ? `@${e.alias}` : "このプロジェクト"}
              </span>
              <span>{roleLabel(e.role) ?? "—"}</span>
              <span className={styles.fields}>
                {e.def.fields.length === 0 ? "タグ" : e.def.fields.length}
              </span>
            </button>
          ))}
        </section>
      )}
      {view === "card" && (
        <section className={styles.grid} aria-label="KokoState の一覧">
          {shown.map((e) => {
            const role = roleLabel(e.role);
            return (
              <button
                key={e.def.id}
                type="button"
                className={styles.card}
                aria-label={e.def.name}
                title={fieldsText(e.def)}
                onClick={() => pick(e.def.id)}
              >
                <span className={styles.thumb} aria-hidden="true">
                  <KokoIcon size={34} />
                </span>
                <span className={styles.name}>{e.def.name}</span>
                <span className={styles.meta}>
                  {e.def.builtin ? (
                    <span className={ui.badge}>Built-in</span>
                  ) : e.alias ? (
                    <span className={ui.badgeBrand}>@{e.alias}</span>
                  ) : null}
                  {role && <span className={ui.badge}>{role}</span>}
                  <span className={styles.fields}>
                    {e.def.fields.length === 0 ? "タグ" : `${e.def.fields.length} fields`}
                  </span>
                </span>
              </button>
            );
          })}
        </section>
      )}
      {shown.length === 0 && (
        <p className={ui.empty}>
          {entries.length === 0
            ? "付けられる KokoState はありません"
            : "当てはまる KokoState はありません"}
        </p>
      )}
    </div>
  );
}

const fieldsText = (def: KokoStateDef) =>
  def.fields.map((f) => `${f.name}: ${f.type}`).join("\n") || "フィールドなし（タグ）";

function KokoIcon({ size }: { size: number }) {
  return (
    <svg
      role="img"
      aria-label="KokoState"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 7l8-4 8 4v10l-8 4-8-4z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </svg>
  );
}

function ViewIcon({ view }: { view: View }) {
  return (
    <svg
      role="img"
      aria-label={view === "table" ? "表" : "カード"}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {view === "card" ? (
        <>
          <rect x="4" y="4" width="6" height="6" rx="1" />
          <rect x="14" y="4" width="6" height="6" rx="1" />
          <rect x="4" y="14" width="6" height="6" rx="1" />
          <rect x="14" y="14" width="6" height="6" rx="1" />
        </>
      ) : (
        <path d="M4 5h16v14H4zM4 10h16M10 10v9" />
      )}
    </svg>
  );
}
