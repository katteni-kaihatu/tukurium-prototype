import {
  emptyProject,
  gunAndTargetSample,
  gunSample,
  targetRangeSample,
} from "@tukurium/repo-model";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useWorkspace } from "../workspace/store";
import styles from "./Header.module.css";
import { useApp } from "./store";

/** 画面上部のバー。セッション中はワークスペースの切り替えと参加者を出す。 */
export function Header({ inSession = false }: { inSession?: boolean }) {
  const { myName, status, session, me } = useApp();
  const location = useLocation();
  const libraryOpen = useWorkspace((s) => s.libraryOpen);
  const others = (session?.participants ?? []).filter((p) => p.id !== me?.id);

  return (
    <header className={`glass ${styles.header}`}>
      <Link to="/" className={styles.brand} aria-label="ツクリウム ホーム">
        <span className={styles.logo} aria-hidden="true" />
        <span className={styles.wordmark}>ツクリウム</span>
      </Link>
      <nav aria-label="メイン" className={styles.nav}>
        <Link
          to="/"
          className={location.pathname === "/" || inSession ? styles.navActive : styles.navItem}
        >
          作る
        </Link>
        <Link
          to="/explore"
          className={location.pathname === "/explore" ? styles.navActive : styles.navItem}
        >
          探す
        </Link>
        {inSession ? (
          <button
            type="button"
            className={libraryOpen ? styles.navActive : styles.navItem}
            aria-pressed={libraryOpen}
            onClick={() => useWorkspace.setState({ libraryOpen: !libraryOpen })}
          >
            ライブラリ
          </button>
        ) : (
          <Link
            to="/u/me"
            className={location.pathname.startsWith("/u/") ? styles.navActive : styles.navItem}
          >
            ライブラリ
          </Link>
        )}
      </nav>
      {inSession && session && (
        <>
          <span className={styles.divider} />
          <WorkspaceSwitcher />
        </>
      )}
      <div className={styles.spacer} />
      <ul className={styles.people} aria-label="セッションの参加者">
        <li className={styles.person}>
          <span className={styles.initial}>{myName.slice(0, 1)}</span>
          <span>{myName}</span>
          <span className={styles.you}>{session?.owner === me?.id ? "持ち主" : "あなた"}</span>
        </li>
        {inSession &&
          others.map((p) => (
            <li key={p.id} className={styles.person}>
              <span className={`${styles.initial} ${styles.initialOther}`}>
                {p.name.slice(0, 1)}
              </span>
              <span>{p.name}</span>
              {session?.owner === p.id && <span className={styles.you}>持ち主</span>}
            </li>
          ))}
      </ul>
      <span className={styles.status} data-status={status} title="サーバーとの接続">
        {status === "online"
          ? "接続中"
          : status === "connecting"
            ? "接続しています…"
            : "オフライン"}
      </span>
    </header>
  );
}

function WorkspaceSwitcher() {
  const session = useApp((s) => s.session);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const [open, setOpen] = useState(false);
  const current = session?.workspaces.find((w) => w.id === workspaceId);
  const ws = useWorkspace.getState();

  return (
    <div className={styles.switcher}>
      <button
        type="button"
        className={styles.switchBtn}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="このセッションのワークスペース"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.switchText}>
          <span className={styles.switchLabel}>ワークスペース</span>
          <b className={styles.switchName}>{current?.name ?? "開いていません"}</b>
        </span>
        <span className={styles.count} title="このセッションのワークスペース数">
          {session?.workspaces.length ?? 0}
        </span>
      </button>
      {open && session && (
        <div className={`glass ${styles.popover}`} role="dialog" aria-label="ワークスペース">
          <p className={styles.popTitle}>
            セッション: {session.name} · {session.workspaces.length}つ開いています
          </p>
          <ul className={styles.wsList}>
            {session.workspaces.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className={styles.wsItem}
                  aria-current={w.id === workspaceId || undefined}
                  onClick={() => {
                    ws.open(w.id);
                    setOpen(false);
                  }}
                >
                  <b>{w.name}</b>
                  <span className={styles.wsMeta}>
                    {w.present.length}人 · {w.mode === "edit" ? "編集中" : "再生中"}
                    {w.defaultRole === null && " · 非公開"}
                  </span>
                  {w.id === workspaceId && <span className={styles.here}>いまここ</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className={styles.popActions}>
            <button
              type="button"
              className={styles.popBtn}
              onClick={() => {
                ws.create("新しいワークスペース", emptyProject("新しいワークスペース"));
                setOpen(false);
              }}
            >
              ＋ 空のワークスペース
            </button>
            <button
              type="button"
              className={styles.popBtn}
              onClick={() => {
                ws.create("銃と的", gunAndTargetSample());
                setOpen(false);
              }}
            >
              ＋ サンプル「銃と的」
            </button>
            <button
              type="button"
              className={styles.popBtn}
              onClick={() => {
                ws.create("銃", gunSample());
                setOpen(false);
              }}
            >
              ＋ サンプル「銃」
            </button>
            <button
              type="button"
              className={styles.popBtn}
              onClick={() => {
                ws.create("射撃場", targetRangeSample());
                setOpen(false);
              }}
            >
              ＋ サンプル「射撃場」
            </button>
            {workspaceId && (
              <button
                type="button"
                className={styles.popBtn}
                onClick={() => {
                  ws.leave();
                  setOpen(false);
                }}
              >
                ワークスペースを閉じる
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
