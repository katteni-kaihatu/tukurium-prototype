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
import { WorkspaceCloseButton, WorkspaceLeaveClose } from "../workspace/workspaceExit";
import { GlobalNav } from "./GlobalNav";
import styles from "./Header.module.css";
import { useLayoutEdge } from "./layoutEdges";
import { RightPanel } from "./RightPanel";
import { canPutAway, listedSessionItems, whoPlaced } from "./sessionItemList";
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
            <WorkspaceNotice />
            <WorkspaceSwitcher />
          </div>
          <SessionItems session={session} />
        </>
      )}
    </section>
  );
}

/** セッションに出ているアイテムの一覧と、ワールド・バッグの入口 */
function SessionItems({ session }: { session: SessionInfo }) {
  const me = useApp((s) => s.me);
  const client = useApp((s) => s.client);
  const belongingsOpen = useWorkspace((s) => s.belongingsOpen);
  const bagOpen = useWorkspace((s) => s.bagOpen);
  const items = listedSessionItems(session.placements);
  const world = session.placements.find((placement) => placement.outputKind === "world");
  return (
    <>
      <div className={styles.sectionHead}>
        <h2>アイテム</h2>
        <span className={styles.sectionCount}>{items.length}件</span>
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
        {items.length === 0 ? (
          <p className={styles.emptyItems}>まだ出ていません。</p>
        ) : (
          <ul className={styles.placed} aria-label="セッションに出ているアイテム">
            {items.map((placement) => {
              const who = whoPlaced(session.participants, placement.placedBy, me?.id);
              return (
                <li key={placement.id} className={styles.placedItem}>
                  <span className={styles.itemMark} data-tone="item" aria-hidden="true">
                    物
                  </span>
                  <span className={styles.itemText}>
                    <b>{placement.outputName}</b>
                    <span>
                      {who}が出しています · {placement.workspaceName}
                    </span>
                  </span>
                  {canPutAway(placement, me?.id, session.owner, session.workspaces) && (
                    <button
                      type="button"
                      className={styles.putAway}
                      aria-label={`${placement.outputName}をセッションから外す`}
                      onClick={() => client.send({ t: "unplace", placementId: placement.id })}
                    >
                      外す
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
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
            <b>{world?.outputName ?? "ワールド"}</b>
            <span>{world ? "開いているワールド" : "ワールドを開く"}</span>
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

/** 閉じられた・開けなかった理由。制作を始めると消える。 */
function WorkspaceNotice() {
  const notice = useWorkspace((s) => s.error);
  if (!notice) return null;
  return (
    <p className={styles.notice} role="status">
      {notice}
    </p>
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
                <li key={workspace.id} className={styles.wsRow}>
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
                  <WorkspaceCloseButton
                    workspaceId={workspace.id}
                    name={workspace.name}
                    className={styles.wsClose}
                  />
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
              <WorkspaceLeaveClose className={styles.popBtn} closeClassName={styles.popBtnClose} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
