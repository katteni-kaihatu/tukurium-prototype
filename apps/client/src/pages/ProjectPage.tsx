import type { FileChange, ProjectSnapshot } from "@tukurium/repo-model";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Header } from "../app/Header";
import { useApp } from "../app/store";
import {
  api,
  type CommitInfo,
  type ExtractSelection,
  type RepoDetail,
  type RepoMeta,
} from "../net/api";
import styles from "./pages.module.css";

type Tab = "code" | "commits" | "releases" | "settings";

/** GitHub 風の機能のうち、初版では見た目だけのもの（計画 §9） */
const LATER = ["Issues", "Pull requests", "Actions", "Branches"];

const shortOid = (oid: string) => oid.slice(0, 7);
const when = (ts: number) => new Date(ts * 1000).toLocaleString("ja-JP");

/** プロジェクト（リポジトリ）のページ */
export function ProjectPage() {
  const { repoId = "" } = useParams();
  const [repo, setRepo] = useState<RepoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("code");
  const [extracting, setExtracting] = useState(false);
  const navigate = useNavigate();
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

  const fork = async () => {
    try {
      const r = await api.fork(repoId);
      navigate(`/p/${r.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={styles.page}>
      <Header />
      <main className={styles.main}>
        {error && <p className={styles.error}>{error}</p>}
        {repo && (
          <>
            <section className={styles.card}>
              <h1 className={styles.title}>
                <Link to={`/u/${repo.owner}`}>{repo.ownerName}</Link>
                <span style={{ color: "var(--c-ink-4)" }}>/</span>
                <b>{repo.name}</b>
                <span className={styles.badge}>
                  {repo.visibility === "public" ? "Public" : "Private"}
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
                  Fork
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={!repo.canFork}
                  onClick={() => setExtracting(true)}
                >
                  抽出…
                </button>
              </div>
              <div className={styles.tabs} role="tablist" aria-label="プロジェクト">
                {(
                  [
                    ["code", "Code"],
                    ["commits", "Commits"],
                    ["releases", "Releases"],
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
                    Settings
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

/** 「新しいセッションで開く」：セッションを作り、そのワークスペースとして開く */
export function OpenInSession({ repoId, repoName }: { repoId: string; repoName: string }) {
  const { client, session } = useApp();
  const navigate = useNavigate();
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (waiting && session) navigate(`/s/${session.id}?open=${repoId}`);
  }, [waiting, session, navigate, repoId]);
  return (
    <button
      type="button"
      className={styles.primary}
      onClick={() => {
        setWaiting(true);
        client.send({ t: "session.create", name: `${repoName} の作業部屋` });
      }}
    >
      新しいセッションで開く
    </button>
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
      <aside className={styles.card} aria-label="About">
        <h2 className={styles.h2}>About</h2>
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
    <section className={styles.card} aria-label="コミット">
      <h2 className={styles.h2}>Commits · {commits.length}</h2>
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

function ReleasesTab({ repo, onChange }: { repo: RepoDetail; onChange: () => void }) {
  const [outputId, setOutputId] = useState(repo.outputs[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const unpublished = repo.outputs.filter((o) => !repo.works.some((w) => w.outputId === o.id));
  return (
    <section className={styles.card} aria-label="作品とリリース">
      <h2 className={styles.h2}>作品とリリース</h2>
      <p className={styles.sub}>
        作品はアウトプットごとの公開の単位です。リリースはコミットからビルドしたバージョンで、リリース後も開発は続けられ、リリース済みのバージョンは変わりません。
      </p>
      {error && <p className={styles.error}>{error}</p>}
      {repo.works.length === 0 && <p className={styles.sub}>まだ作品はありません。</p>}
      {repo.works.map((w) => (
        <div key={w.id} className={styles.card} style={{ boxShadow: "none" }}>
          <div className={styles.row}>
            <b className={styles.grow}>{w.name}</b>
            {repo.isOwner && (
              <button
                type="button"
                className={styles.primary}
                onClick={() => void run(() => api.release(w.id))}
              >
                最新のコミットからリリース
              </button>
            )}
          </div>
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
                  checked={w.perms[k]}
                  disabled={!repo.isOwner}
                  onChange={(e) =>
                    void run(() => api.updateWork(w.id, { perms: { [k]: e.target.checked } }))
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <ul className={styles.list} aria-label={`${w.name} のリリース`}>
            {w.releases.length === 0 && <li className={styles.sub}>リリースはまだありません</li>}
            {w.releases.map((r, i) => (
              <li key={r.id}>
                <b>v{r.version}</b>
                {i === 0 && <span className={styles.badge}>Latest</span>}
                <span className={styles.grow} />
                <span className={styles.mono}>{shortOid(r.commit)}</span>
                <span className={styles.sub}>{new Date(r.createdAt).toLocaleString("ja-JP")}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {repo.isOwner && unpublished.length > 0 && (
        <div className={styles.row}>
          <select
            className={styles.select}
            aria-label="公開するアウトプット"
            value={outputId}
            onChange={(e) => setOutputId(e.target.value)}
          >
            {unpublished.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.primary}
            onClick={() =>
              void run(() => api.publish(repo.id, outputId || unpublished[0]?.id || ""))
            }
          >
            作品として公開
          </button>
        </div>
      )}
    </section>
  );
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
      <h2 className={styles.h2}>General</h2>
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
        公開範囲（現在 {repo.visibility === "public" ? "Public" : "Private"}）
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
          {repo.visibility === "public" ? "Private にする" : "Public にする"}
        </button>
      </div>
      <h2 className={styles.h2}>Danger Zone</h2>
      <div className={styles.row}>
        <button type="button" className={styles.btn} disabled title="初版では見た目だけです">
          Transfer ownership
        </button>
        <button type="button" className={styles.btn} disabled title="初版では見た目だけです">
          Delete this repository
        </button>
      </div>
    </section>
  );
}

/** 抽出：アウトプットかリソースを選び、新しいプロジェクトか自分の既存のプロジェクトに取り込む */
function ExtractDialog({ repo, onClose }: { repo: RepoDetail; onClose: () => void }) {
  const me = useApp((s) => s.me);
  const navigate = useNavigate();
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  const [mine, setMine] = useState<RepoMeta[]>([]);
  const [sel, setSel] = useState<ExtractSelection>({
    outputs: [],
    kokostates: [],
    systems: [],
    materials: [],
    assets: [],
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
