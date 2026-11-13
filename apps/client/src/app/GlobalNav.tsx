import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCatalog } from "../main-menu/catalogStore";
import { MenuIcon, type MenuIconName } from "../main-menu/MenuIcon";
import { AVAILABILITY, useSocial } from "../main-menu/socialStore";
import { type ToolWindow, useMainMenu } from "../main-menu/store";
import { AvatarFace } from "./AvatarFace";
import styles from "./GlobalNav.module.css";
import { useLayoutEdge } from "./layoutEdges";
import { useApp } from "./store";

type Entry = {
  icon: MenuIconName;
  label: string;
  /** 開くウィンドウ。ないものは、まだ画面のない項目（ボタンだけ置く） */
  window?: ToolWindow;
  /** 名前と見た目の文字が違うときの、読み上げの名前 */
  name?: string;
};

const ENTRIES: Entry[] = [
  { icon: "home", label: "ホーム", window: "home" },
  { icon: "timeline", label: "タイムライン" },
  { icon: "friends", label: "フレンド", window: "friends" },
  { icon: "sessions", label: "セッション", window: "sessions" },
  { icon: "events", label: "イベント" },
  { icon: "groups", label: "グループ" },
  { icon: "worlds", label: "ワールド", window: "worlds" },
  { icon: "items", label: "アイテム", window: "items" },
  { icon: "market", label: "マーケット", window: "market" },
  { icon: "projects", label: "プロジェクト", window: "projects" },
  {
    icon: "workspaces",
    label: "ワークスペース",
    window: "workspaces",
    name: "ワークスペースを開く",
  },
  { icon: "library", label: "ライブラリ", window: "library" },
];

/**
 * アプリ全体の入口。名前つきで開いた形と、アイコンだけの列にたたんだ形を切り替える。
 * 参加前は開き、セッション内ではたたむ。3D 空間を操作している間は、いつもアイコンだけにする。
 */
export function GlobalNav({ inSession }: { inSession: boolean }) {
  const [expanded, setExpanded] = useState(
    () => !inSession && (typeof window === "undefined" || window.innerWidth > 1000),
  );
  const [locked, setLocked] = useState(() => document.pointerLockElement !== null);
  useEffect(() => {
    const update = () => setLocked(document.pointerLockElement !== null);
    update();
    document.addEventListener("pointerlockchange", update);
    return () => document.removeEventListener("pointerlockchange", update);
  }, []);
  const open = expanded && !locked;
  const nav = useRef<HTMLElement>(null);
  useLayoutEdge(nav);
  const windows = useMainMenu((s) => s.windows);
  const owned = useCatalog((s) => s.owned.length);
  const unread = useSocial(
    (s) =>
      (s.data?.incoming.length ?? 0) +
      (s.data?.invitations.incoming.filter((i) => i.status === "pending").length ?? 0),
  );
  return (
    <aside
      ref={nav}
      className={`glass ${styles.nav}`}
      aria-label="グローバルメニュー"
      data-expanded={open}
      data-app-edge
      data-app-nav
    >
      <div className={styles.top}>
        <button
          type="button"
          className={styles.toggle}
          aria-label={open ? "メニューをたたむ" : "メニューを開く"}
          aria-expanded={open}
          title={open ? "たたむ" : "開く"}
          disabled={locked}
          onClick={() => setExpanded((value) => !value)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        {open && <b className={styles.wordmark}>ツクリウム</b>}
      </div>
      <span className={styles.rule} aria-hidden="true" />
      <nav className={styles.list} aria-label="アプリの画面">
        {ENTRIES.map((entry) => {
          const id = entry.window;
          const count = id === "friends" ? unread : id === "items" ? owned : 0;
          return (
            <button
              key={entry.label}
              type="button"
              className={styles.entry}
              aria-label={entry.name ?? entry.label}
              title={open ? undefined : entry.label}
              data-window-button={id}
              aria-pressed={id ? windows[id].open : undefined}
              onClick={id ? () => useMainMenu.getState().showWindow(id) : undefined}
            >
              <MenuIcon page={entry.icon} />
              <span className={styles.label}>{entry.label}</span>
              {count > 0 && (
                <span
                  className={styles.badge}
                  data-tone={id === "friends" ? "alert" : undefined}
                  aria-hidden="true"
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <span className={styles.spacer} />
      {open && (
        <fieldset className={styles.section}>
          <legend className={styles.sectionLabel}>クライアントモード</legend>
          <div className={styles.segment}>
            <button type="button" aria-pressed="false">
              2D
            </button>
            <button type="button" aria-pressed="true">
              3D
            </button>
          </div>
        </fieldset>
      )}
      {inSession && <SessionExit compact={!open} />}
      <Me compact={!open} />
    </aside>
  );
}

/** 自分の顔と状態。押すとステータスのウィンドウを開く */
function Me({ compact }: { compact: boolean }) {
  const me = useApp((s) => s.me);
  const profile = useSocial((s) => s.data?.profile);
  const name = me?.name ?? "";
  const state = profile ? AVAILABILITY[profile.availability] : "オンライン";
  const line = profile?.note ? `${state} · ${profile.note}` : state;
  return (
    <div className={styles.me}>
      <button
        type="button"
        className={styles.meButton}
        data-window-button="status"
        aria-label={`ステータスを変える（${name}・${line}）`}
        title="ステータスを変える"
        onClick={() => useMainMenu.getState().showWindow("status")}
      >
        <span className={styles.avatar} data-status={profile?.availability ?? "online"}>
          <AvatarFace user={me} />
        </span>
        {!compact && (
          <span className={styles.meText}>
            <b>{name}</b>
            <span data-status={profile?.availability ?? "online"}>{line}</span>
          </span>
        )}
      </button>
      {!compact && (
        <button
          type="button"
          className={styles.settings}
          data-window-button="account"
          aria-label="アカウント"
          title="アカウント"
          onClick={() => useMainMenu.getState().showWindow("account")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** セッションの終わり方。持ち主はセッションごと閉じ、ほかの人は自分だけ出る */
function SessionExit({ compact }: { compact: boolean }) {
  const { client, session, me } = useApp();
  const navigate = useNavigate();
  if (!session) return null;
  const owner = session.owner === me?.id;
  const label = owner ? "セッションを閉じる" : "セッションを出る";
  return (
    <button
      type="button"
      className={styles.exit}
      aria-label={label}
      title={owner ? label : "セッションは続きます。自分だけ出ます"}
      onClick={() => {
        if (!owner) {
          navigate("/");
          return;
        }
        if (
          confirm(
            "セッションを閉じますか？中にいる人の画面も終わり、このセッションはなくなります。作ったプロジェクトは残ります。",
          )
        )
          client.send({ t: "session.close" });
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10" />
      </svg>
      {!compact && <span>{label}</span>}
    </button>
  );
}
