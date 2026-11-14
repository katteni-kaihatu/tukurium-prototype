import type { FileChange, ProjectSnapshot } from "@tukurium/repo-model";
import { splitTagDraft, workTagsSchema } from "@tukurium/shared";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Header } from "../app/Header";
import { useApp } from "../app/store";
import { editProject } from "../main-menu/editing";
import { useMainMenu } from "../main-menu/store";
import { PublicTagsField, WorkTagsEditor } from "../main-menu/WorkTags";
import {
  api,
  type CommitInfo,
  type ExtractSelection,
  type RepoDetail,
  type RepoMeta,
} from "../net/api";
import { ProjectLink as Link, useProjectNavigate } from "./ProjectNavigation";
import styles from "./pages.module.css";

type Tab = "code" | "commits" | "releases" | "settings";

/** GitHub 風の機能のうち、初版では見た目だけのもの（計画 §9） */
const LATER = ["変更提案"];

const shortOid = (oid: string) => oid.slice(0, 7);
const when = (ts: number) => new Date(ts * 1000).toLocaleString("ja-JP");

/** プロジェクト（リポジトリ）のページ */
export function ProjectPage({
  embedded = false,
  projectId,
}: {
  embedded?: boolean;
  projectId?: string;
}) {
  const params = useParams();
  const repoId = projectId ?? params.repoId ?? "";
  const [repo, setRepo] = useState<RepoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("code");
  const [extracting, setExtracting] = useState(false);
  const navigate = useProjectNavigate();
  const me = useApp((s) => s.me);

  const load = useCallback(() => {
    api
      .repo(repoId)
      .then((r) => {
        setRepo(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [repoId]);
  // 本人確認（トークン）が済んでから読む
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const [exporting, setExporting] = useState(false);
  const exportZip = async (r: RepoDetail) => {
    setExporting(true);
    try {
      await api.exportRepo(r.id, r.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const fork = async () => {
    try {
      const r = await api.fork(repoId);
      navigate(`/p/${r.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={embedded ? styles.embedded : styles.page}>
      {!embedded && <Header />}
      <main className={embedded ? styles.embeddedMain : styles.main}>
        {error && <p className={styles.error}>{error}</p>}
        {repo && (
          <>
            <section className={styles.card}>
              <h1 className={styles.title}>
                <Link to={`/u/${repo.owner}`}>{repo.ownerName}</Link>
                <span style={{ color: "var(--c-ink-4)" }}>/</span>
                <b>{repo.name}</b>
                <span className={styles.badge}>
                  {repo.visibility === "public" ? "公開" : "非公開"}
                </span>
              </h1>
              {repo.forkedFrom && (
                <p className={styles.sub}>
                  フォーク元：
                  <Link className={styles.link} to={`/p/${repo.forkedFrom.repoId}`}>
                    {repo.forkedFrom.repoName}
                  </Link>{" "}
                  <span className={styles.mono}>{shortOid(repo.forkedFrom.commit)}</span>
                </p>
              )}
              <div className={styles.row}>
                <OpenInSession repoId={repo.id} repoName={repo.name} />
                <button
                  type="button"
                  className={styles.btn}
                  disabled={!repo.canFork}
                  onClick={() => void fork()}
                >
                  フォーク
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={!repo.canFork}
                  onClick={() => setExtracting(true)}
                >
                  抽出…
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={!repo.canFork || !repo.head || exporting}
                  title="最新の保存と素材を Zip にしてダウンロードします"
                  onClick={() => void exportZip(repo)}
                >
                  {exporting ? "書き出しています…" : "Zip でエクスポート"}
                </button>
              </div>
              <div className={styles.tabs} role="tablist" aria-label="プロジェクト">
                {(
                  [
                    ["code", "リソース"],
                    ["commits", "履歴"],
                    ["releases", "リリース"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    className={styles.tab}
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
                {LATER.map((label) => (
                  <button
                    key={label}
                    type="button"
                    role="tab"
                    className={styles.tab}
                    disabled
                    title="初版では見た目だけです"
                  >
                    {label}
                  </button>
                ))}
                {repo.isOwner && (
                  <button
                    type="button"
                    role="tab"
                    className={styles.tab}
                    aria-selected={tab === "settings"}
                    onClick={() => setTab("settings")}
                  >
                    設定
                  </button>
                )}
              </div>
            </section>
            {tab === "code" && <CodeTab repo={repo} />}
            {tab === "commits" && <CommitsTab repo={repo} />}
            {tab === "releases" && <ReleasesTab repo={repo} onChange={load} />}
            {tab === "settings" && repo.isOwner && <SettingsTab repo={repo} onChange={load} />}
            {extracting && <ExtractDialog repo={repo} onClose={() => setExtracting(false)} />}
          </>
        )}
      </main>
    </div>
  );
}

/** プロジェクトを今いるセッションで編集する。未参加なら先に場所を選ぶ。 */
export function OpenInSession({ repoId }: { repoId: string; repoName: string }) {
  const session = useApp((s) => s.session);
  const { editingPending, editingError } = useMainMenu();
  return (
    <>
      <button
        type="button"
        className={styles.primary}
        disabled={editingPending}
        onClick={() => editProject(repoId)}
      >
        {editingPending
          ? "ワークスペースを開いています…"
          : session
            ? "このセッションで編集する"
            : "セッションを選んで編集する"}
      </button>
      {editingError && (
        <p className={styles.error} role="alert">
          {editingError}
        </p>
      )}
    </>
  );
}

function CodeTab({ repo }: { repo: RepoDetail }) {
  const [files, setFiles] = useState<string[]>([]);
  const [last, setLast] = useState<CommitInfo | null>(null);
  useEffect(() => {
    void api.files(repo.id).then((f) => setFiles(Object.keys(f).sort()));
    void api.commits(repo.id).then((c) => setLast(c[0] ?? null));
  }, [repo.id]);
  return (
    <div className={styles.grid}>
      <section className={styles.card} aria-label="ファイル">
        {last && (
          <p className={styles.sub}>
            <b>{last.author.name}</b> {last.message.split("\n")[0]} ·{" "}
            <span className={styles.mono}>{shortOid(last.oid)}</span> ·{" "}
            {when(last.author.timestamp)}
          </p>
        )}
        <ul className={styles.list}>
          {files.map((f) => (
            <li key={f} className={styles.mono}>
              {f}
            </li>
          ))}
        </ul>
      </section>
      <aside className={styles.card} aria-label="このプロジェクトについて">
        <h2 className={styles.h2}>このプロジェクトについて</h2>
        <p className={styles.sub}>{repo.description || "（説明はありません）"}</p>
        <h2 className={styles.h2}>アウトプット</h2>
        <ul className={styles.list}>
          {repo.outputs.map((o) => (
            <li key={o.id}>
              <span className={styles.grow}>{o.name}</span>
              <span className={styles.badge}>{o.kind}</span>
            </li>
          ))}
        </ul>
        {repo.provenance.length > 0 && (
          <>
            <h2 className={styles.h2}>由来</h2>
            <ul className={styles.list}>
              {repo.provenance.map((p) => (
                <li
                  key={`${p.repoId}-${p.at}`}
                  style={{ flexDirection: "column", alignItems: "flex-start" }}
                >
                  <span>
                    {p.kind === "fork" ? "フォーク元" : "抽出元"}：
                    <Link className={styles.link} to={`/p/${p.repoId}`}>
                      {p.repoName}
                    </Link>{" "}
                    <span className={styles.mono}>{shortOid(p.commit)}</span>
                  </span>
                  {p.items.length > 0 && <span className={styles.sub}>{p.items.join("、")}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}

function CommitsTab({ repo }: { repo: RepoDetail }) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileChange[]>([]);
  useEffect(() => {
    void api.commits(repo.id).then(setCommits);
  }, [repo.id]);
  useEffect(() => {
    if (open) void api.diff(repo.id, open).then(setDiff);
  }, [repo.id, open]);
  return (
    <section className={styles.card} aria-label="履歴">
      <h2 className={styles.h2}>履歴 · {commits.length}</h2>
      <ul className={styles.list}>
        {commits.map((c) => (
          <li key={c.oid} style={{ flexDirection: "column", alignItems: "stretch" }}>
            <button
              type="button"
              className={styles.row}
              style={{ border: 0, background: "transparent", textAlign: "left", padding: 0 }}
              aria-expanded={open === c.oid}
              onClick={() => setOpen(open === c.oid ? null : c.oid)}
            >
              <span className={styles.grow}>
                <b>{c.message.split("\n")[0]}</b>
                <span className={styles.sub}>
                  {" "}
                  · {c.author.name} · {when(c.author.timestamp)}
                  {c.message.includes("Co-authored-by") && " · 共同制作"}
                </span>
              </span>
              <span className={styles.mono}>{shortOid(c.oid)}</span>
            </button>
            {open === c.oid && (
              <ul
                className={styles.list}
                aria-label="前のコミットとの差分"
                style={{ marginTop: 8 }}
              >
                {diff.map((d) => (
                  <li key={d.path} className={styles.mono}>
                    <span className={styles.grow}>{d.path}</span>
                    <span className={styles.added}>+{d.add}</span>
                    <span className={styles.removed}>−{d.del}</span>
                    {d.change !== "modified" && (
                      <span className={styles.badge}>
                        {d.change === "added" ? "new" : "deleted"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const KIND_LABEL: Record<string, string> = {
  world: "ワールド",
  item: "アイテム",
  library: "ライブラリ",
};

function kindLabel(kind: string | null): string {
  return (kind && KIND_LABEL[kind]) || "アウトプット";
}

/** 左はアウトプット、右はそのバージョン。リリースはアウトプットごとに一つ。 */
function ReleasesTab({ repo, onChange }: { repo: RepoDetail; onChange: () => void }) {
  const rows = releaseRows(repo);
  const [picked, setPicked] = useState(rows[0]?.key ?? "");
  const [publishTags, setPublishTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = rows.find((row) => row.key === picked) ?? rows[0] ?? null;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className={styles.card} aria-label="リリースとバージョン">
      <h2 className={styles.h2}>リリース</h2>
      <p className={styles.sub}>
        左のアウトプットを選ぶと、右にそのバージョンが出ます。出したバージョンは、その後の開発では変わりません。
      </p>
      {error && <p className={styles.error}>{error}</p>}
      {rows.length === 0 ? (
        <p className={styles.sub}>アウトプットがありません。</p>
      ) : (
        <div className={styles.releaseSplit}>
          <ul className={styles.outputList} aria-label="アウトプット">
            {rows.map((row) => {
              const latest = row.work?.releases[0];
              const state = !row.work ? "未公開" : latest ? `v${latest.version}` : "公開済み";
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    className={styles.outputBtn}
                    aria-pressed={selected?.key === row.key}
                    onClick={() => {
                      setPicked(row.key);
                      setPublishTags("");
                    }}
                  >
                    <span className={styles.outputName}>{row.name}</span>
                    <span className={styles.sub}>
                      {kindLabel(row.kind)} · {state}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected && (
            <ReleaseDetail
              repo={repo}
              row={selected}
              publishTags={publishTags}
              onTags={setPublishTags}
              onRun={run}
              onChange={onChange}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ReleaseDetail({
  repo,
  row,
  publishTags,
  onTags,
  onRun,
  onChange,
}: {
  repo: RepoDetail;
  row: ReleaseRow;
  publishTags: string;
  onTags: (value: string) => void;
  onRun: (fn: () => Promise<unknown>) => Promise<void>;
  onChange: () => void;
}) {
  const work = row.work;
  return (
    <section className={styles.releaseDetail} aria-label={`${row.name} のリリース`}>
      <div className={styles.row}>
        <h3 className={styles.h2}>{row.name}</h3>
        <span className={styles.badge}>{kindLabel(row.kind)}</span>
        <span className={styles.grow} />
        {repo.isOwner && work && (
          <button
            type="button"
            className={styles.primary}
            onClick={() => void onRun(() => api.release(work.id))}
          >
            最新のコミットからバージョンを出す
          </button>
        )}
      </div>
      {work ? (
        <>
          <fieldset className={styles.row} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className={styles.label}>権限</legend>
            {(
              [
                ["use", "利用"],
                ["view", "元データ閲覧"],
                ["fork", "フォーク／抽出"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className={styles.choice} style={{ padding: "6px 10px" }}>
                <input
                  type="checkbox"
                  checked={work.perms[k]}
                  disabled={!repo.isOwner}
                  onChange={(e) =>
                    void onRun(() => api.updateWork(work.id, { perms: { [k]: e.target.checked } }))
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <WorkTagsEditor work={work} onSaved={onChange} />
          <h3 className={styles.h2}>バージョン · {work.releases.length}</h3>
          {work.releases.length === 0 ? (
            <p className={styles.sub}>バージョンはまだありません。</p>
          ) : (
            <ol className={styles.history}>
              {work.releases.map((release, index) => (
                <li key={release.id} className={styles.historyItem}>
                  <span className={styles.historyTitle}>
                    v{release.version}
                    {index === 0 && <span className={styles.badge}>最新</span>}
                  </span>
                  <span className={styles.sub}>
                    {new Date(release.createdAt).toLocaleString("ja-JP")} ·{" "}
                    <span className={styles.mono}>{shortOid(release.commit)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <div>
          <p className={styles.sub}>このアウトプットは、まだリリースしていません。</p>
          {repo.isOwner && row.outputId && (
            <>
              <PublicTagsField value={publishTags} onChange={onTags} />
              <div className={styles.row}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!workTagsSchema.safeParse(splitTagDraft(publishTags)).success}
                  onClick={() =>
                    void onRun(async () => {
                      await api.publish(
                        repo.id,
                        row.outputId ?? "",
                        workTagsSchema.parse(splitTagDraft(publishTags)),
                      );
                      onTags("");
                    })
                  }
                >
                  リリースする
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

type ReleaseRow = {
  key: string;
  name: string;
  kind: string | null;
  outputId: string | null;
  work: RepoDetail["works"][number] | null;
};

function releaseRows(repo: RepoDetail): ReleaseRow[] {
  const byOutput = new Map(repo.works.map((work) => [work.outputId, work]));
  const rows: ReleaseRow[] = repo.outputs.map((output) => ({
    key: output.id,
    name: output.name,
    kind: output.kind,
    outputId: output.id,
    work: byOutput.get(output.id) ?? null,
  }));
  for (const work of repo.works) {
    if (repo.outputs.some((output) => output.id === work.outputId)) continue;
    rows.push({
      key: work.id,
      name: work.name,
      kind: work.outputKind ?? null,
      outputId: null,
      work,
    });
  }
  return rows;
}

function SettingsTab({ repo, onChange }: { repo: RepoDetail; onChange: () => void }) {
  const [name, setName] = useState(repo.name);
  const [description, setDescription] = useState(repo.description);
  const [error, setError] = useState<string | null>(null);
  const save = (body: { name?: string; description?: string }) => {
    setError(null);
    void api.updateRepo(repo.id, body).then(onChange, (e: Error) => setError(e.message));
  };
  return (
    <section className={styles.card} aria-label="設定">
      <h2 className={styles.h2}>基本</h2>
      <div className={styles.field}>
        <label htmlFor="repo-name">プロジェクト名</label>
        <input
          id="repo-name"
          className={styles.input}
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.btn}
          disabled={!name.trim() || name.trim() === repo.name}
          onClick={() => save({ name: name.trim() })}
        >
          名前を変える
        </button>
        <span className={styles.sub}>
          開いているワークスペースにもすぐ反映されます。履歴には次のコミットで入ります。
        </span>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.field}>
        <label htmlFor="repo-desc">説明</label>
        <textarea
          id="repo-desc"
          className={styles.textarea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className={styles.row}>
        <button type="button" className={styles.btn} onClick={() => save({ description })}>
          保存
        </button>
      </div>
      <h2 className={styles.h2}>
        公開範囲（現在 {repo.visibility === "public" ? "公開" : "非公開"}）
      </h2>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.btn}
          onClick={() =>
            void api
              .updateRepo(repo.id, {
                visibility: repo.visibility === "public" ? "private" : "public",
              })
              .then(onChange)
          }
        >
          {repo.visibility === "public" ? "非公開にする" : "公開にする"}
        </button>
      </div>
      <h2 className={styles.h2}>危険な操作</h2>
      <div className={styles.row}>
        <button type="button" className={styles.btn} disabled title="初版では見た目だけです">
          持ち主を移す
        </button>
        <button type="button" className={styles.btn} disabled title="初版では見た目だけです">
          このプロジェクトを消す
        </button>
      </div>
    </section>
  );
}

/** 抽出：アウトプットかリソースを選び、新しいプロジェクトか自分の既存のプロジェクトに取り込む */
function ExtractDialog({ repo, onClose }: { repo: RepoDetail; onClose: () => void }) {
  const me = useApp((s) => s.me);
  const navigate = useProjectNavigate();
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  const [mine, setMine] = useState<RepoMeta[]>([]);
  const [sel, setSel] = useState<ExtractSelection>({
    outputs: [],
    kokostates: [],
    systems: [],
    materials: [],
    assets: [],
    prefabs: [],
  });
  const [target, setTarget] = useState<"new" | "existing">("new");
  const [name, setName] = useState(`${repo.name} から抽出`);
  const [into, setInto] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.snapshot(repo.id).then(setSnap);
    if (me) void api.repos(me.id).then((r) => setMine(r.filter((x) => x.id !== repo.id)));
  }, [repo.id, me]);

  const groups: {
    key: keyof ExtractSelection;
    label: string;
    items: { id: string; name: string }[];
  }[] = snap
    ? [
        { key: "outputs", label: "アウトプット", items: snap.outputs },
        { key: "prefabs", label: "プレハブ", items: snap.prefabs ?? [] },
        { key: "kokostates", label: "KokoState", items: snap.kokostates },
        { key: "systems", label: "System", items: snap.systems },
        { key: "materials", label: "マテリアル", items: snap.materials },
        { key: "assets", label: "素材", items: snap.assets ?? [] },
      ]
    : [];
  const count = Object.values(sel).reduce((n, l) => n + l.length, 0);
  const toggle = (key: keyof ExtractSelection, id: string, on: boolean) =>
    setSel((s) => ({ ...s, [key]: on ? [...s[key], id] : s[key].filter((x) => x !== id) }));

  const submit = async () => {
    try {
      const res = await api.extract(
        repo.id,
        sel,
        target === "new" ? { name } : { repoId: into || mine[0]?.id || "" },
      );
      navigate(`/p/${res.repo.id}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="抽出">
      <section className={`${styles.card} ${styles.dialogBox}`}>
        <h2 className={styles.h2}>抽出：{repo.name}</h2>
        <p className={styles.sub}>
          選んだものは、使っているもの（Entity・System・KokoState・マテリアル・素材）と一緒に取り出されます。由来（元のプロジェクトとコミット）が残ります。
        </p>
        {groups.map((g) =>
          g.items.length === 0 ? null : (
            <fieldset key={g.key} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className={styles.label}>{g.label}</legend>
              <div className={styles.choices}>
                {g.items.map((it) => (
                  <label key={it.id} className={styles.choice} style={{ padding: "6px 10px" }}>
                    <input
                      type="checkbox"
                      checked={sel[g.key].includes(it.id)}
                      onChange={(e) => toggle(g.key, it.id, e.target.checked)}
                    />
                    {it.name}
                  </label>
                ))}
              </div>
            </fieldset>
          ),
        )}
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className={styles.label}>取り込み先</legend>
          <div className={styles.choices}>
            <label className={styles.choice}>
              <input
                type="radio"
                name="target"
                checked={target === "new"}
                onChange={() => setTarget("new")}
              />
              新しいプロジェクト
            </label>
            <label className={styles.choice}>
              <input
                type="radio"
                name="target"
                checked={target === "existing"}
                disabled={mine.length === 0}
                onChange={() => setTarget("existing")}
              />
              自分の既存のプロジェクト
            </label>
          </div>
        </fieldset>
        {target === "new" ? (
          <input
            className={styles.input}
            aria-label="新しいプロジェクトの名前"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : (
          <select
            className={styles.select}
            aria-label="取り込み先のプロジェクト"
            value={into}
            onChange={(e) => setInto(e.target.value)}
          >
            {mine.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.row}>
          <button type="button" className={styles.btn} onClick={onClose}>
            やめる
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={count === 0}
            onClick={() => void submit()}
          >
            {count} 件を抽出
          </button>
        </div>
      </section>
    </div>
  );
}
