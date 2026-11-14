import type { FieldSchemas } from "@tukurium/eks";
import {
  collectSelection,
  type ExtractSelection,
  extractInto,
  isBuiltin,
  type ProjectSnapshot,
  parsePackageResourceId,
  ResourcePathIndex,
} from "@tukurium/repo-model";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../app/store";
import { api, type RepoMeta } from "../net/api";
import { useCanEdit, useProject } from "./hooks";
import styles from "./ImportPanel.module.css";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

/** 選んだもの（型の定義も、いつも一覧を持つ） */
type Picked = Required<ExtractSelection>;
type Group = keyof Picked;

const GROUPS: { key: Group; label: string }[] = [
  { key: "outputs", label: "アウトプット" },
  { key: "prefabs", label: "プレハブ" },
  { key: "kokostates", label: "KokoState" },
  { key: "systems", label: "Script" },
  { key: "materials", label: "Material" },
  { key: "assets", label: "素材" },
  { key: "types", label: "型の定義" },
];

const EMPTY: Picked = {
  outputs: [],
  kokostates: [],
  systems: [],
  materials: [],
  assets: [],
  types: [],
  prefabs: [],
};

interface Source {
  repoId: string;
  repoName: string;
  commit: string;
  snapshot: ProjectSnapshot;
  /** 取り出し元のフィールドのスキーマ（サーバーが作る。ADR 0065） */
  schemas?: FieldSchemas;
}

interface Row {
  id: string;
  name: string;
  /** 論理パス（アウトプットは種類） */
  where: string;
}

/**
 * ほかのプロジェクトから取り込む（ADR 0052）。
 * 左で取り込み元のプロジェクトと、その中のアウトプット・リソースを選ぶ。右には、一緒に取り込まれる
 * 依存（Entity が使う KokoState・マテリアル・素材、System が使う KokoState、ライブラリ）をまとめて出す。
 * 右下の「インポート」で、開いているワークスペースへ足す。由来（元のリポジトリ・コミット・パス）を残す。
 */
export function ImportPanel() {
  const project = useProject();
  const canEdit = useCanEdit();
  const me = useApp((s) => s.me);
  const session = useApp((s) => s.session);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const ownRepo = session?.workspaces.find((w) => w.id === workspaceId)?.repoId ?? null;
  const [repos, setRepos] = useState<RepoMeta[]>([]);
  const [repoId, setRepoId] = useState<string>("");
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked>(EMPTY);

  useEffect(() => {
    let alive = true;
    api.repos().then(
      (list) => {
        if (alive) setRepos(list.filter((r) => r.id !== ownRepo));
      },
      (e: Error) => {
        if (alive) setError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [ownRepo]);

  useEffect(() => {
    setSource(null);
    setPicked(EMPTY);
    setDone(null);
    if (!repoId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api.importSource(repoId).then(
      (src) => {
        if (!alive) return;
        setSource(src);
        setLoading(false);
      },
      (e: Error) => {
        if (!alive) return;
        setError(e.message);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [repoId]);

  const rows = useMemo(() => (source ? rowsOf(source.snapshot) : null), [source]);
  const together = useMemo(
    () => (source ? withDependencies(source.snapshot, picked, source.schemas) : null),
    [source, picked],
  );
  const count = GROUPS.reduce((n, g) => n + picked[g.key].length, 0);

  const toggle = (group: Group, id: string) =>
    setPicked((cur) => ({
      ...cur,
      [group]: cur[group].includes(id) ? cur[group].filter((x) => x !== id) : [...cur[group], id],
    }));

  const runImport = () => {
    if (!source || count === 0) return;
    try {
      setError(null);
      const merged = extractInto(
        source.snapshot,
        picked,
        { repoId: source.repoId, repoName: source.repoName, commit: source.commit },
        { ...project.snapshot(), name: project.name },
        undefined,
        source.schemas,
      );
      project.mergeAdditions(merged);
      setDone(`${source.repoName} から ${count} 件を取り込みました`);
      setPicked(EMPTY);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const mine = repos.filter((r) => r.owner === me?.id);
  const others = repos.filter((r) => r.owner !== me?.id);

  return (
    <div className={styles.frame}>
      <div className={styles.top}>
        <label className={ui.label} htmlFor="import-repo">
          取り込み元
        </label>
        <select
          id="import-repo"
          className={ui.select}
          value={repoId}
          onChange={(e) => setRepoId(e.target.value)}
        >
          <option value="">プロジェクトを選ぶ</option>
          {mine.length > 0 && (
            <optgroup label="自分のプロジェクト">
              {mine.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label="公開されているプロジェクト">
              {others.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}（{r.ownerName}）
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      <div className={styles.split}>
        <section className={styles.pick} aria-label="取り込むもの">
          {!repoId ? (
            <p className={ui.muted}>取り込み元のプロジェクトを選ぶと、中身が出ます</p>
          ) : loading ? (
            <p className={ui.muted}>読み込んでいます…</p>
          ) : rows ? (
            GROUPS.map((g) =>
              rows[g.key].length === 0 ? null : (
                <fieldset key={g.key} className={styles.group}>
                  <legend className={ui.sectionTitle}>{g.label}</legend>
                  {rows[g.key].map((row) => (
                    <label key={row.id} className={styles.row}>
                      <input
                        type="checkbox"
                        checked={picked[g.key].includes(row.id)}
                        onChange={() => toggle(g.key, row.id)}
                      />
                      <span className={styles.name}>{row.name}</span>
                      <span className={styles.where}>{row.where}</span>
                    </label>
                  ))}
                </fieldset>
              ),
            )
          ) : null}
        </section>
        <aside className={styles.side} aria-label="一緒に取り込むもの">
          <h3 className={ui.sectionTitle}>一緒に取り込むもの</h3>
          {!together || (together.rows.length === 0 && together.libraries.length === 0) ? (
            <p className={ui.muted}>
              選んだものが使う
              KokoState・Script・マテリアル・素材・ライブラリが、ここにまとめて出ます
            </p>
          ) : (
            <ul className={ui.list}>
              {together.rows.map((r) => (
                <li key={r.id} className={ui.item}>
                  <span className={ui.itemName}>{r.name}</span>
                  <span className={ui.badge}>{r.kind}</span>
                </li>
              ))}
              {together.libraries.map((alias) => (
                <li key={alias} className={ui.item}>
                  <span className={ui.itemName}>@{alias}</span>
                  <span className={ui.badge}>ライブラリ</span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
      <div className={styles.foot}>
        <span className={styles.source}>
          {source
            ? `${source.repoName} · ${source.commit.slice(0, 7)} から（由来に元のリポジトリ・コミット・パスを残します）`
            : ""}
        </span>
        {error && <span className={ui.error}>{error}</span>}
        {done && <span className={styles.done}>{done}</span>}
        <button
          type="button"
          className={ui.btnPrimary}
          disabled={!canEdit || !source || count === 0}
          title={canEdit ? undefined : "編集できる人だけが取り込めます"}
          onClick={runImport}
        >
          インポート{count > 0 ? `（${count}）` : ""}
        </button>
      </div>
    </div>
  );
}

function rowsOf(snap: ProjectSnapshot): Record<Group, Row[]> {
  const index = ResourcePathIndex.fromSnapshot(snap);
  const where = (id: string) => index.pathOf(id) ?? "";
  return {
    outputs: snap.outputs.map((o) => ({
      id: o.id,
      name: o.name,
      where: o.kind === "world" ? "ワールド" : o.kind === "library" ? "ライブラリ" : "アイテム",
    })),
    kokostates: snap.kokostates
      .filter((k) => !k.builtin)
      .map((k) => ({ id: k.id, name: k.name, where: where(k.id) })),
    systems: snap.systems.map((x) => ({ id: x.id, name: x.name, where: where(x.id) })),
    materials: snap.materials.map((m) => ({ id: m.id, name: m.name, where: where(m.id) })),
    assets: (snap.assets ?? []).map((a) => ({ id: a.id, name: a.name, where: where(a.id) })),
    types: (snap.types ?? []).map((t) => ({ id: t.id, name: t.name, where: where(t.id) })),
    prefabs: (snap.prefabs ?? []).map((p) => ({ id: p.id, name: p.name, where: where(p.id) })),
  };
}

/** 選んだものが使うもの（選んだもの自身は除く）と、使うライブラリの別名 */
function withDependencies(
  snap: ProjectSnapshot,
  picked: Picked,
  schemas: FieldSchemas | undefined,
): { rows: { id: string; name: string; kind: string }[]; libraries: string[] } {
  const all: Picked = { ...EMPTY, ...collectSelection(snap, picked, schemas) };
  const chosen = new Set(GROUPS.flatMap((g) => picked[g.key]));
  const rows: { id: string; name: string; kind: string }[] = [];
  const label: Record<Group, string> = {
    outputs: "アウトプット",
    kokostates: "KokoState",
    systems: "Script",
    materials: "Material",
    assets: "素材",
    types: "型の定義",
    prefabs: "プレハブ",
  };
  const nameOf = (group: Group, id: string): string | null => {
    switch (group) {
      case "outputs":
        return snap.outputs.find((x) => x.id === id)?.name ?? null;
      case "kokostates":
        return snap.kokostates.find((x) => x.id === id)?.name ?? null;
      case "systems":
        return snap.systems.find((x) => x.id === id)?.name ?? null;
      case "materials":
        return snap.materials.find((x) => x.id === id)?.name ?? null;
      case "assets":
        return snap.assets?.find((x) => x.id === id)?.name ?? null;
      case "types":
        return snap.types?.find((x) => x.id === id)?.name ?? null;
      case "prefabs":
        return snap.prefabs?.find((x) => x.id === id)?.name ?? null;
    }
  };
  for (const g of GROUPS) {
    for (const id of all[g.key]) {
      if (chosen.has(id) || isBuiltin(id)) continue;
      const name = nameOf(g.key, id);
      if (name) rows.push({ id, name, kind: label[g.key] });
    }
  }
  // ライブラリ：依存から取り込んだ ID（pkg:…）か、`@別名/` の import を使っているもの
  const deps = snap.dependencies ?? [];
  const libraries = new Set<string>();
  const ids = [...all.kokostates, ...all.systems, ...all.prefabs];
  for (const e of snap.entities) {
    if (!all.outputs.includes(e.output)) continue;
    ids.push(...Object.keys(e.states));
  }
  for (const e of snap.prefabEntities ?? []) {
    if (!all.prefabs.includes(e.prefab)) continue;
    ids.push(...Object.keys(e.states));
  }
  for (const id of ids) {
    const ref = parsePackageResourceId(id);
    const dep = ref && deps.find((d) => d.packageId === ref.packageId && d.version === ref.version);
    if (dep) libraries.add(dep.alias);
  }
  for (const s of snap.systems) {
    if (!all.systems.includes(s.id)) continue;
    for (const d of deps) if (s.code.includes(`"@${d.alias}/`)) libraries.add(d.alias);
  }
  return { rows, libraries: [...libraries].sort() };
}
