import {
  emptyProject,
  forestSample,
  gunAndTargetSample,
  gunSample,
  marubatsuSample,
  targetRangeSample,
} from "@tukurium/repo-model";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { beginEditing } from "../main-menu/editing";
import { useMainMenu } from "../main-menu/store";
import { useWorkspace } from "../workspace/store";
import { AppSidebar } from "./AppSidebar";
import styles from "./Header.module.css";
import { useApp } from "./store";

/** 上のバーは、今いるセッションの操作と状態だけを表示する。 */
export function Header({ inSession = false }: { inSession?: boolean }) {
  const { session, me, status } = useApp();
  const windows = useMainMenu((s) => s.windows);
  const bar = useRef<HTMLElement>(null);
  const belongingsOpen = useWorkspace((s) => s.belongingsOpen);
  const bagOpen = useWorkspace((s) => s.bagOpen);
  const present = inSession && session;
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const update = () => {
      const bottom = element.getBoundingClientRect().bottom;
      document.documentElement.style.setProperty("--app-bar-bottom", `${bottom}px`);
      document.documentElement.style.setProperty("--app-panel-top", `${bottom + 12}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  return createPortal(
    <>
      <AppSidebar />
      <header ref={bar} className={`glass ${styles.header}`} data-session-bar>
        <button
          type="button"
          className={styles.brand}
          aria-label="ホーム"
          title="ホーム"
          data-window-button="home"
          aria-pressed={windows.home.open}
          onClick={() => useMainMenu.getState().show("home")}
        >
          <span className={styles.logo} aria-hidden="true" />
          <span className={styles.wordmark}>ツクリウム</span>
        </button>
        <div className={styles.sessionInfo}>
          <span className={styles.sessionLabel}>現在のセッション</span>
          <strong>{present ? session.name : "セッション未参加"}</strong>
          {present && <span className={styles.memberCount}>{session.participants.length}人</span>}
        </div>
        <WorkspaceSwitcher />
        {present && (
          <>
            <nav className={styles.nav} aria-label="セッションの操作">
              <button
                type="button"
                className={belongingsOpen ? styles.navActive : styles.navItem}
                aria-pressed={belongingsOpen}
                onClick={() => useWorkspace.setState({ belongingsOpen: !belongingsOpen })}
              >
                セッション {session.placements.length}
              </button>
              <button
                type="button"
                className={bagOpen ? styles.navActive : styles.navItem}
                aria-pressed={bagOpen}
                onClick={() => useWorkspace.setState({ bagOpen: !bagOpen })}
              >
                バッグ
              </button>
            </nav>
            <ul className={styles.people} aria-label="セッションの参加者">
              {session.participants.map((person) => (
                <li key={person.id} className={styles.person}>
                  <span className={styles.initial}>{person.name.slice(0, 1)}</span>
                  <span>{person.name}</span>
                  {(person.id === session.owner || person.id === me?.id) && (
                    <span className={styles.you}>
                      {person.id === session.owner ? "持ち主" : "あなた"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <SessionExit />
          </>
        )}
        <span
          className={styles.connection}
          data-status={status}
          title={
            status === "online"
              ? "接続中"
              : status === "connecting"
                ? "接続しています…"
                : "オフライン"
          }
        >
          <span className={styles.connectionDot} />
          <span className={styles.connectionText}>
            {status === "online" ? "接続中" : status === "connecting" ? "接続中…" : "オフライン"}
          </span>
        </span>
      </header>
    </>,
    document.body,
  );
}

/** セッションの終わり方。持ち主はセッションごと閉じ、ほかの人は自分だけ出る */
function SessionExit() {
  const { client, session, me } = useApp();
  const navigate = useNavigate();
  const owner = session?.owner === me?.id;
  if (owner) {
    return (
      <button
        type="button"
        className={styles.leave}
        onClick={() => {
          if (
            confirm(
              "セッションを閉じますか？中にいる人の画面も終わり、このセッションはなくなります。作ったプロジェクトは残ります。",
            )
          ) {
            client.send({ t: "session.close" });
          }
        }}
      >
        セッションを閉じる
      </button>
    );
  }
  return (
    <button
      type="button"
      className={styles.leave}
      title="セッションは続きます。自分だけ出ます"
      onClick={() => navigate("/")}
    >
      セッションを出る
    </button>
  );
}

/** 旧表示の、現在の名前と数を示すワークスペース切り替え。 */
function WorkspaceSwitcher() {
  const session = useApp((s) => s.session);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const ready = useWorkspace((s) => s.ready);
  const { editingPending, editingError } = useMainMenu();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const wasPending = useRef(false);
  const current = session?.workspaces.find((w) => w.id === workspaceId);
  useEffect(() => {
    if (editingPending) wasPending.current = true;
    else if (wasPending.current) {
      wasPending.current = false;
      if (!editingError && ready) setOpen(false);
    }
  }, [editingPending, editingError, ready]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [open]);
  const returnToEditing = () => {
    useWorkspace.setState({ panelsHidden: false });
    useMainMenu.setState((s) => ({ workspaceRecall: s.workspaceRecall + 1, activeWindow: null }));
    setOpen(false);
  };
  return (
    <div className={styles.switcher} ref={root}>
      <button
        type="button"
        className={styles.switchBtn}
        data-window-button="workspaces"
        aria-label="ワークスペース"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="このセッションのワークスペース"
        onClick={() => {
          if (!session) {
            useMainMenu.getState().showProject("/workspaces");
            return;
          }
          useMainMenu.setState({ activeWindow: null });
          setOpen((value) => !value);
        }}
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
        <div
          className={`glass ${styles.popover}`}
          role="dialog"
          aria-label="ワークスペース"
          data-workspace-popover
        >
          <p className={styles.popTitle}>
            セッション: {session.name} · {session.workspaces.length}つ開いています
          </p>
          {ready && (
            <button type="button" className={styles.popBtn} onClick={returnToEditing}>
              編集画面に戻る
            </button>
          )}
          {editingPending && <p role="status">ワークスペースを開いています…</p>}
          {editingError && <p role="alert">{editingError}</p>}
          <section aria-label="制作を始める">
            <ul className={styles.wsList} aria-label="このセッションのワークスペース">
              {session.workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <button
                    type="button"
                    className={styles.wsItem}
                    aria-current={workspace.id === workspaceId || undefined}
                    disabled={editingPending}
                    onClick={() =>
                      beginEditing(() => useWorkspace.getState().open(workspace.id), workspace.id)
                    }
                  >
                    <b>{workspace.name}</b>
                    <span className={styles.wsMeta}>
                      {workspace.present.length}人 ·{" "}
                      {workspace.mode === "edit" ? "編集中" : "再生中"}
                      {workspace.defaultRole === null && " · 非公開"}
                    </span>
                    {workspace.id === workspaceId && <span className={styles.here}>いまここ</span>}
                  </button>
                </li>
              ))}
            </ul>
            <div className={styles.popActions}>
              {(
                [
                  ["空のワークスペース", () => emptyProject("新しいワークスペース")],
                  ["サンプル「銃と的」で作る", gunAndTargetSample],
                  ["サンプル「銃」", gunSample],
                  ["サンプル「射撃場」", targetRangeSample],
                  ["サンプル「森」", forestSample],
                  ["サンプル「マルバツ」", marubatsuSample],
                ] as const
              ).map(([label, create]) => (
                <button
                  key={label}
                  type="button"
                  className={styles.popBtn}
                  disabled={editingPending}
                  onClick={() =>
                    beginEditing(() => {
                      const project = create();
                      useWorkspace.getState().create(project.name, project);
                    })
                  }
                >
                  ＋ {label}
                </button>
              ))}
              <button
                type="button"
                className={styles.popBtn}
                onClick={() => {
                  setOpen(false);
                  useMainMenu.getState().showProject("/workspaces");
                }}
              >
                プロジェクト・ほかのサンプルから開く
              </button>
              {workspaceId && (
                <button
                  type="button"
                  className={styles.popBtn}
                  disabled={editingPending}
                  onClick={() => useWorkspace.getState().leave()}
                >
                  ワークスペースを閉じる
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
