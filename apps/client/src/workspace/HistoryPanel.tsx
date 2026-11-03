import { diffFiles, type FileChange, toFiles } from "@tukurium/repo-model";
import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { api, type CommitInfo } from "../net/api";
import { useProject } from "./hooks";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

/**
 * History：未コミットの変更、コミット（意図的な保存）、履歴（要件 §9）。
 * 作業途中の内容は自動保存されている（コミットとは別）。
 */
export function HistoryPanel() {
  const project = useProject();
  const { workspaceId, commitRev } = useWorkspace();
  const rev = useWorkspace((s) => s.rev);
  const { client, session, me } = useApp();
  const repoId = session?.workspaces.find((w) => w.id === workspaceId)?.repoId ?? null;
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [headFiles, setHeadFiles] = useState<Record<string, string> | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: コミットのたびに読み直す
  useEffect(() => {
    if (!repoId) return;
    api.commits(repoId).then(setCommits, (e: Error) => setError(e.message));
    api.files(repoId).then(setHeadFiles, () => setHeadFiles({}));
    api.repo(repoId).then(
      (r) => setOwner(r.owner),
      () => {},
    );
  }, [repoId, commitRev]);

  // 未コミットの変更（最新のコミットとの差分）。編集のたびに少し待ってから計算する
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev（制作データの変更）で計算し直す
  useEffect(() => {
    if (!headFiles) return;
    const t = setTimeout(
      () =>
        setChanges(diffFiles(headFiles, toFiles({ ...project.snapshot(), name: project.name }))),
      300,
    );
    return () => clearTimeout(t);
  }, [headFiles, project, rev]);

  if (!repoId) return <p className={ui.empty}>このワークスペースにはプロジェクトがありません</p>;
  const isOwner = owner === me?.id;
  const others = (session?.workspaces.find((w) => w.id === workspaceId)?.present ?? []).filter(
    (id) => id !== me?.id,
  );
  const names = others.map((id) => session?.participants.find((p) => p.id === id)?.name ?? id);

  return (
    <>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <h3 className={ui.sectionTitle}>未コミットの変更</h3>
          <span className={changes.length > 0 ? ui.badgeWarn : ui.badge}>{changes.length}件</span>
        </div>
        {changes.length === 0 ? (
          <p className={ui.muted}>すべてコミット済みです。作業内容は自動保存されています。</p>
        ) : (
          <ul className={ui.list} aria-label="未コミットの変更">
            {changes.slice(0, 12).map((c) => (
              <li key={c.path} className={ui.item} style={{ cursor: "default" }}>
                <span className={`${ui.itemName} ${ui.num}`}>{c.path}</span>
                <span className={ui.num} style={{ color: "#1f6b47" }}>
                  +{c.add}
                </span>
                <span className={ui.num} style={{ color: "#8a2a2a" }}>
                  −{c.del}
                </span>
              </li>
            ))}
          </ul>
        )}
        <label className={ui.label} htmlFor="commit-message">
          コミットメッセージ
        </label>
        <input
          id="commit-message"
          className={ui.input}
          value={message}
          maxLength={500}
          disabled={!isOwner}
          placeholder={isOwner ? "何を変えたか" : "コミットできるのはプロジェクトの持ち主です"}
          onChange={(e) => setMessage(e.target.value)}
        />
        {names.length > 0 && <p className={ui.muted}>Co-author: {names.join("、")}</p>}
        {error && <p className={ui.error}>{error}</p>}
        <div className={ui.toolbar}>
          <button
            type="button"
            className={ui.btnPrimary}
            disabled={!isOwner || !message.trim() || !workspaceId}
            onClick={() => {
              if (!workspaceId) return;
              client.send({ t: "ws.commit", workspaceId, message: message.trim() });
              setMessage("");
            }}
          >
            コミット
          </button>
          <a className={ui.btn} href={`/p/${repoId}`} target="_blank" rel="noreferrer">
            プロジェクトのページ
          </a>
        </div>
      </div>
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>History</h3>
        <ol className={ui.list} aria-label="コミットの履歴">
          {commits.map((c) => (
            <li key={c.oid} className={ui.item} style={{ cursor: "default", flexWrap: "wrap" }}>
              <span className={ui.itemName}>{c.message.split("\n")[0]}</span>
              <span className={ui.muted}>
                {c.author.name} · {new Date(c.author.timestamp * 1000).toLocaleString("ja-JP")}
              </span>
              <code className={ui.num}>{c.oid.slice(0, 7)}</code>
            </li>
          ))}
        </ol>
        <p className={ui.muted}>
          ブランチの作成・main へのマージ・revert は初版では見た目だけです。
        </p>
        <div className={ui.toolbar}>
          <button type="button" className={ui.btn} disabled title="初版では見た目だけです">
            ＋ ブランチを作成
          </button>
          <button type="button" className={ui.btn} disabled title="初版では見た目だけです">
            main にマージ
          </button>
        </div>
      </div>
    </>
  );
}
