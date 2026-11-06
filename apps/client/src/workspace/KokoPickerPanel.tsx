import type { KokoStateDef } from "@tukurium/eks";
import { useState } from "react";
import { useProject } from "./hooks";
import styles from "./KokoPickerPanel.module.css";
import { catalogEntries, catalogTags, filterCatalog, roleLabel } from "./kokoCatalog";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { packageAliasOf } from "./useProblems";

/**
 * KokoState を付けるウィンドウ。検索欄・件数付きのタグ（出どころ・役割）・カードで選ぶ。
 * 選ぶと、開いたときの Entity に付けて閉じる。
 */
export function KokoPickerPanel({ entityId }: { entityId: string }) {
  const project = useProject();
  useWorkspace((s) => s.rev);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const entity = project.entity(entityId);
  if (!entity) return <p className={ui.empty}>Entity が見つかりません</p>;
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
  const close = () => useWorkspace.setState({ kokoPicker: null });

  return (
    <div className={styles.root}>
      <p className={ui.muted}>「{entity.name}」に付ける KokoState を選びます。</p>
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
      <section className={styles.grid} aria-label="KokoState の一覧">
        {shown.map((e) => {
          const role = roleLabel(e.role);
          return (
            <button
              key={e.def.id}
              type="button"
              className={styles.card}
              aria-label={e.def.name}
              title={e.def.fields.map((f) => `${f.name}: ${f.type}`).join("\n") || "フィールドなし"}
              onClick={() => {
                try {
                  project.addState(entityId, e.def.id);
                  close();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              <span className={styles.thumb} aria-hidden="true">
                <svg
                  role="img"
                  aria-label="KokoState"
                  width="34"
                  height="34"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 7l8-4 8 4v10l-8 4-8-4z" />
                  <path d="M4 7l8 4 8-4M12 11v10" />
                </svg>
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
