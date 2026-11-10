import {
  emptyProject,
  forestSample,
  gunAndTargetSample,
  gunSample,
  marubatsuSample,
  targetRangeSample,
} from "@tukurium/repo-model";
import type { SessionInfo } from "@tukurium/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { beginEditing } from "../main-menu/editing";
import { useMainMenu } from "../main-menu/store";
import { useWorkspace } from "../workspace/store";
import { GlobalNav } from "./GlobalNav";
import styles from "./Header.module.css";
import { useLayoutEdge } from "./layoutEdges";
import { RightPanel } from "./RightPanel";
import { useApp } from "./store";

/**
 * 画面の枠。左のグローバルメニュー、左上のセッションの札、右の欄、セッション内なら左の欄を置く。
 * 上のバーは置かない（ADR 0062）。
 */
export function Header({ inSession = false }: { inSession?: boolean }) {
  const session = useApp((s) => s.session);
  const present = inSession && session ? session : null;
  return createPortal(
    <>
      <GlobalNav inSession={inSession} />
      <SessionTag session={present} />
      {present && <SessionSidebar session={present} />}
      <RightPanel inSession={Boolean(present)} />
    </>,
    document.body,
  );
}

/** 左上の札。今いるセッションの名前・ワールドと、接続の状態 */
function SessionTag({ session }: { session: SessionInfo | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEdge(ref);
  const status = useApp((s) => s.status);
  const world = session?.placements.find((p) => p.outputKind === "world")?.outputName;
  const connection =
    status === "online" ? "接続中" : status === "connecting" ? "接続しています…" : "オフライン";
  return (
    <div ref={ref} className={`glass ${styles.tag}`} data-session-bar>
      <span
        className={styles.connectionDot}
        data-status={status}
        role="img"
        aria-label={connection}
        title={connection}
      />
      <span className={styles.tagText}>
        <strong>{session ? session.name : "セッション未参加"}</strong>
        <span>
          {session ? `ワールド：${world ?? "なし"} · ${session.participants.length}人` : connection}
        </span>
      </span>
      {session && (
        <button type="button" className={styles.iconButton} aria-label="セッションの設定">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
          </svg>
        </button>
      )}
    </div>
  );
}

const narrow = () => typeof window !== "undefined" && window.innerWidth <= 760;

/**
 * セッション内の左の欄：プレイヤー・ワークスペース・アイテム。
 * 制作中は、空間とパネルを広く使えるようにたたんで始める。
 */
function SessionSidebar({ session }: { session: SessionInfo }) {
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLElement>(null);
  useLayoutEdge(ref);
  const editing = useWorkspace((s) => !!s.project && !s.panelsHidden);
  const [collapsed, setCollapsed] = useState(() => editing || narrow());
  // 制作を始めたらたたみ、やめたら開く（狭い画面ではたたんだまま）
  const [wasEditing, setWasEditing] = useState(editing);
  if (wasEditing !== editing) {
    setWasEditing(editing);
    setCollapsed(editing || narrow());
  }
  return (
    <section
      ref={ref}
      className={`glass ${collapsed ? styles.rail : styles.sidebar}`}
      aria-label={
        collapsed
          ? "プレイヤー・ワークスペース・アイテム（たたんでいる）"
          : "プレイヤー・ワークスペース・アイテム"
      }
      data-app-edge
    >
      {collapsed ? (
        <>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="プレイヤー・ワークスペース・アイテムを開く"
            title="開く"
            onClick={() => setCollapsed(false)}
          >
            ›
          </button>
          {session.participants.slice(0, 4).map((person) => (
            <span key={person.id} className={styles.initial} title={person.name}>
              {person.name.slice(0, 1)}
            </span>
          ))}
          <span className={styles.railCount}>{session.participants.length}人</span>
        </>
      ) : (
        <>
          <div className={styles.sectionHead}>
            <h2>プレイヤー</h2>
            <span className={styles.sectionCount}>{session.participants.length}人</span>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="パネルをたたむ"
              title="たたむ"
              onClick={() => setCollapsed(true)}
            >
              ‹
            </button>
          </div>
          <ul className={styles.people} aria-label="セッションの参加者">
            {session.participants.map((person) => (
              <li key={person.id} className={styles.person}>
                <span className={person.id === me?.id ? styles.initialMe : styles.initial}>
                  {person.name.slice(0, 1)}
                </span>
                <b>{person.name}</b>
                {person.id === me?.id && <span className={styles.you}>あなた</span>}
                {person.id === session.owner && <span className={styles.you}>持ち主</span>}
              </li>
            ))}
          </ul>
          <div className={styles.sectionHead}>
            <h2>ワークスペース</h2>
            <span className={styles.sectionCount}>{session.workspaces.length}つ</span>
          </div>
          <div className={styles.sectionBody}>
            <WorkspaceSwitcher />
          </div>
          <SessionItems session={session} />
        </>
      )}
    </section>
  );
}

/** セッションに出ている作品とバッグの入口。画面共有と表示の切り替えはボタンだけ置く */
function SessionItems({ session }: { session: SessionInfo }) {
  const belongingsOpen = useWorkspace((s) => s.belongingsOpen);
  const bagOpen = useWorkspace((s) => s.bagOpen);
  return (
    <>
      <div className={styles.sectionHead}>
        <h2>アイテム</h2>
        <span className={styles.sectionCount}>{session.placements.length}件</span>
        <button type="button" className={styles.iconButton} aria-label="画面共有" title="画面共有">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16v4" />
          </svg>
        </button>
        <fieldset className={styles.layout}>
          <legend className={styles.hidden}>ウィンドウの表示</legend>
          <button
            type="button"
            aria-pressed="false"
            aria-label="カンタン"
            title="カンタン：開いたものを 1 つ大きく表示し、ほかは下に並べる"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 9h18" />
            </svg>
          </button>
          <button
            type="button"
            aria-pressed="true"
            aria-label="フリー"
            title="フリー：ウィンドウを重ねて表示し、ドラッグで動かす"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <rect x="8" y="3" width="13" height="11" rx="2" />
              <path d="M16 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
            </svg>
          </button>
        </fieldset>
      </div>
      <div className={styles.items}>
        <button
          type="button"
          className={styles.itemRow}
          aria-pressed={belongingsOpen}
          onClick={() => useWorkspace.setState({ belongingsOpen: !belongingsOpen })}
        >
          <span className={styles.itemMark} data-tone="world" aria-hidden="true">
            置
          </span>
          <span className={styles.itemText}>
            <b>セッション {session.placements.length}</b>
            <span>セッションに出ている作品</span>
          </span>
        </button>
        <button
          type="button"
          className={styles.itemRow}
          aria-pressed={bagOpen}
          onClick={() => useWorkspace.setState({ bagOpen: !bagOpen })}
        >
          <span className={styles.itemMark} data-tone="bag" aria-hidden="true">
            袋
          </span>
          <span className={styles.itemText}>
            <b>バッグ</b>
            <span>拾った物</span>
          </span>
        </button>
      </div>
    </>
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
