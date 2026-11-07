import { compileSystem, isBuiltin, ResourcePathIndex } from "@tukurium/repo-model";
import { ChangeMark } from "./ChangeMark";
import { outputChange } from "./changeMarks";
import { useCanEdit, useProject } from "./hooks";
import styles from "./InspectorPanel.module.css";
import { type DetailTarget, useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useSavedFiles } from "./useSavedFiles";

interface Row {
  id: string;
  name: string;
  path: string;
}

/**
 * ライブラリのアウトプットの左側（ADR 0055）。ライブラリは Entity を持たないので、Hierarchy の代わりに
 * 含めるリソースを選ぶ。含めたものだけが Package に入り、使う側から import できる。
 */
export function LibraryContents() {
  const { outputId, selection, select } = useWorkspace();
  const project = useProject();
  const canEdit = useCanEdit();
  const saved = useSavedFiles();
  useWorkspace((s) => s.rev);
  const output = project.output(outputId);
  if (!output) return null;

  const snap = project.snapshot();
  const index = ResourcePathIndex.fromSnapshot(snap);
  const row = (id: string, name: string): Row => ({ id, name, path: index.pathOf(id) ?? name });
  const groups: { kind: DetailTarget["kind"]; label: string; rows: Row[] }[] = [
    {
      kind: "koko",
      label: "KokoState",
      rows: snap.kokostates.filter((k) => !isBuiltin(k.id)).map((k) => row(k.id, k.name)),
    },
    { kind: "system", label: "System", rows: snap.systems.map((s) => row(s.id, s.name)) },
    { kind: "material", label: "マテリアル", rows: snap.materials.map((m) => row(m.id, m.name)) },
    { kind: "asset", label: "素材", rows: (snap.assets ?? []).map((a) => row(a.id, a.name)) },
  ];
  for (const g of groups) g.rows.sort((a, b) => a.path.localeCompare(b.path, "ja"));
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  // スナップショットの方を使う（消したリソースは入っていない）
  const included = new Set(snap.outputs.find((o) => o.id === outputId)?.resources ?? []);
  // 含めた System が import しているのに、含めていないもの（使う側では見つからない）
  const neededBy = new Map<string, string[]>();
  for (const s of snap.systems) {
    if (!included.has(s.id) || !s.code.includes("import")) continue;
    for (const b of compileSystem(s.id, s.code, index).bindings) {
      if (isBuiltin(b.resourceId) || included.has(b.resourceId)) continue;
      neededBy.set(b.resourceId, [...(neededBy.get(b.resourceId) ?? []), s.name]);
    }
  }
  const changes = outputChange(saved, output);
  const showDetail = (kind: DetailTarget["kind"], id: string) =>
    useWorkspace.setState({ resourceDetail: { kind, id }, resourceDetailOpen: true });
  const current = selection?.kind === "output" && selection.id === outputId;

  return (
    <nav className={styles.tree} aria-label="含めるリソース">
      <div className={styles.treeHead}>
        <h3 className={ui.sectionTitle} style={{ whiteSpace: "nowrap" }}>
          含めるリソース
        </h3>
        <span style={{ flex: 1 }} />
        <ChangeMark
          kind={changes.resources}
          target={{ entry: `output:${outputId}`, part: "resources" }}
        />
        <span className={ui.badge}>
          {included.size} / {total}
        </span>
      </div>
      <ul className={ui.list}>
        <li>
          <div className={styles.node} data-current={current || undefined}>
            <span className={styles.fold} />
            <ChangeMark kind={changes.kind} target={{ entry: `output:${outputId}` }} />
            <button
              type="button"
              className={styles.nodeName}
              aria-current={current || undefined}
              onClick={() => select({ kind: "output", id: outputId })}
            >
              <b>{output.name}</b>
            </button>
            <span className={ui.badge}>library</span>
          </div>
        </li>
      </ul>
      <p className={ui.muted} style={{ padding: "4px 6px 8px" }}>
        ライブラリは Entity を持ちません。チェックを付けたものだけがライブラリに入り、使う側から
        import できます。
      </p>
      {total === 0 && <p className={ui.empty}>Resources にまだ何もありません</p>}
      {groups.map((g) =>
        g.rows.length === 0 ? null : (
          <fieldset key={g.kind} className={styles.includeGroup}>
            <legend className={ui.sectionTitle}>{g.label}</legend>
            {g.rows.map((r) => {
              const need = neededBy.get(r.id);
              return (
                <div key={r.id} className={styles.node}>
                  <ChangeMark
                    kind={changes.resourceRows[r.id] ?? null}
                    target={{ entry: `output:${outputId}`, part: "resources" }}
                  />
                  <label className={styles.includeRow}>
                    <input
                      type="checkbox"
                      checked={included.has(r.id)}
                      disabled={!canEdit}
                      onChange={(e) => project.setIncluded(outputId, r.id, e.target.checked)}
                    />
                    <span className={styles.includeName}>{r.name}</span>
                    <span className={styles.includePath}>{r.path}</span>
                  </label>
                  {need && (
                    <span
                      className={ui.badgeError}
                      title={`含めた ${need.join("・")} が import しています。含めないと、使う側では見つかりません`}
                    >
                      要る
                    </span>
                  )}
                  <button
                    type="button"
                    className={ui.iconBtn}
                    aria-label={`${r.name} の詳細`}
                    title="詳細を開く"
                    onClick={() => showDetail(g.kind, r.id)}
                  >
                    ›
                  </button>
                </div>
              );
            })}
          </fieldset>
        ),
      )}
    </nav>
  );
}
