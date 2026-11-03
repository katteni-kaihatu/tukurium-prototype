import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { api } from "../net/api";
import { useProject } from "./hooks";
import styles from "./MainPanel.module.css";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useWorkspaceProblems } from "./useProblems";

const ROLE_LABEL = { viewer: "閲覧", editor: "共同編集", admin: "管理" } as const;

/**
 * ワークスペースのメインパネル：いま選んでいるアウトプットと、再生の状態だけを出す。
 * 再生の操作はホスト（再生を実行する人）に届き、全員に同じ状態が配られる。
 * セッションに出す・適用・リンク先一覧はセッションパネル、問題は問題パネル、
 * ログと保存はログ・保存パネルに分け、下のボタンから開く。
 */
export function MainPanel() {
  const ws = useWorkspace();
  const project = useProject();
  const {
    outputId,
    mode,
    logs,
    role,
    isHost,
    workspaceId,
    historyOpen,
    sessionOpen,
    problemsOpen,
    logOpen,
  } = ws;
  useWorkspace((s) => s.rev);
  const session = useApp((s) => s.session);
  const info = session?.workspaces.find((w) => w.id === workspaceId);
  const hostName = session?.participants.find((p) => p.id === info?.host)?.name;
  const outputs = project.outputs();
  const canOperate = role === "editor" || role === "admin";
  const links = (session?.placements ?? []).filter(
    (p) => p.workspaceId === workspaceId && p.outputId === outputId,
  );
  const problemCount = useWorkspaceProblems().count;

  return (
    <>
      <div className={styles.head}>
        <RepoName repoId={info?.repoId ?? null} name={info?.name ?? project.name} />
        <span className={styles.branch}>main</span>
        {role && (
          <span className={role === "viewer" ? ui.badgeWarn : ui.badgeBrand}>
            {ROLE_LABEL[role]}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {info?.repoId && (
          <a className={ui.btn} href={`/p/${info.repoId}`} target="_blank" rel="noreferrer">
            Project
          </a>
        )}
        <button
          type="button"
          className={ui.btn}
          aria-pressed={historyOpen}
          onClick={() => useWorkspace.setState({ historyOpen: !historyOpen })}
        >
          History
        </button>
        {info?.repoId && (
          <a
            className={ui.btn}
            href={`/p/${info.repoId}`}
            target="_blank"
            rel="noreferrer"
            title="作品の公開とリリースはプロジェクトのページで"
          >
            Releases
          </a>
        )}
      </div>

      <div className={styles.bar}>
        <label className={styles.output}>
          <span className={styles.outputLabel}>
            Output · {project.output(outputId)?.kind === "world" ? "world" : "item"}
          </span>
          <select
            className={ui.select}
            aria-label="アウトプット"
            value={outputId}
            disabled={mode !== "edit"}
            onChange={(e) => {
              if (e.target.value === "__new") {
                const id = project.addOutput(`アウトプット${outputs.length + 1}`, "item");
                ws.setOutput(id);
              } else if (e.target.value === "__newWorld") {
                // ワールドは独立した空間で編集する（ポータルから入る）
                const id = project.addOutput(`ワールド${outputs.length + 1}`, "world");
                ws.setOutput(id);
              } else {
                ws.setOutput(e.target.value);
              }
            }}
          >
            {outputs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            {canOperate && <option value="__new">＋ アイテムを追加</option>}
            {canOperate && <option value="__newWorld">＋ ワールドを追加</option>}
          </select>
        </label>

        <div className={styles.transport}>
          {mode === "edit" ? (
            <button
              type="button"
              className={ui.btnPrimary}
              onClick={ws.play}
              disabled={!canOperate || !info?.host}
            >
              ▶ Play
            </button>
          ) : mode === "play" ? (
            <button type="button" className={ui.btn} onClick={ws.pause} disabled={!canOperate}>
              ❚❚ Pause
            </button>
          ) : (
            <button
              type="button"
              className={ui.btnPrimary}
              onClick={ws.resume}
              disabled={!canOperate}
            >
              ▶ Resume
            </button>
          )}
          <button
            type="button"
            className={ui.btn}
            onClick={ws.stop}
            disabled={!canOperate || mode === "edit"}
          >
            ■ Stop
          </button>
        </div>

        <span className={mode === "edit" ? ui.badge : ui.badgeWarn} aria-live="polite">
          {mode === "edit" ? "Edit mode" : mode === "play" ? "Play mode" : "一時停止中"}
        </span>
      </div>
      <p className={`${ui.muted} ${styles.hostLine}`}>
        {info?.host
          ? `再生の実行（ホスト）: ${isHost ? "あなた" : (hostName ?? "?")}`
          : "ホストを務められる人（管理権限）がいないため、再生できません"}
      </p>

      <div className={styles.panels}>
        <button
          type="button"
          className={ui.btn}
          aria-pressed={sessionOpen}
          onClick={() => useWorkspace.setState({ sessionOpen: !sessionOpen })}
        >
          セッション
          {links.length > 0 && <span className={ui.badge}>リンク先 {links.length}</span>}
        </button>
        <button
          type="button"
          className={ui.btn}
          aria-pressed={problemsOpen}
          onClick={() => useWorkspace.setState({ problemsOpen: !problemsOpen })}
        >
          問題
          {problemCount.errors + problemCount.warnings > 0 ? (
            <span
              className={ui.badgeError}
              title={
                problemCount.stale ? `ほかに編集前の結果が ${problemCount.stale} 件` : undefined
              }
            >
              {problemCount.errors + problemCount.warnings}
            </span>
          ) : problemCount.stale > 0 ? (
            <span
              className={ui.badgeError}
              data-fresh="stale"
              title="編集前の結果（確かめ直しています）"
            >
              {problemCount.stale}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={ui.btn}
          aria-pressed={logOpen}
          onClick={() => useWorkspace.setState({ logOpen: !logOpen })}
        >
          ログ・保存
          {logs.length > 0 && <span className={ui.badge}>{logs.length}</span>}
        </button>
      </div>
    </>
  );
}

/** プロジェクト名。持ち主はその場で変えられる（Enter で決定、Esc でやめる） */
function RepoName({ repoId, name }: { repoId: string | null; name: string }) {
  const me = useApp((s) => s.me);
  const [owner, setOwner] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOwner(null);
    if (!repoId) return;
    api.repo(repoId).then(
      (r) => setOwner(r.owner),
      () => setOwner(null),
    );
  }, [repoId]);
  const canRename = repoId !== null && owner !== null && owner === me?.id;

  const commit = () => {
    const next = draft?.trim() ?? "";
    setDraft(null);
    if (!repoId || !next || next === name) return;
    api.updateRepo(repoId, { name: next }).then(
      () => setError(null),
      (e: Error) => setError(e.message),
    );
  };

  if (draft !== null) {
    return (
      <input
        className={ui.input}
        aria-label="プロジェクト名"
        value={draft}
        maxLength={64}
        // biome-ignore lint/a11y/noAutofocus: 名前の編集を始めた直後に入力できるように
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
        style={{ width: 200 }}
      />
    );
  }
  return (
    <span className={styles.repo}>
      <b title={error ?? undefined}>{name}</b>
      {canRename && (
        <button
          type="button"
          className={ui.iconBtn}
          aria-label="プロジェクト名を変える"
          title="プロジェクト名を変える"
          onClick={() => setDraft(name)}
        >
          ✎
        </button>
      )}
    </span>
  );
}
