import { useLayoutEffect, useRef, useState } from "react";
import { acceptInvitation } from "../main-menu/Invitations";
import { useSocial } from "../main-menu/socialStore";
import { useMainMenu } from "../main-menu/store";
import { useWorkspace } from "../workspace/store";
import { updateLayoutEdges, useLayoutEdge } from "./layoutEdges";
import styles from "./RightPanel.module.css";
import { useApp } from "./store";

const narrow = () => typeof window !== "undefined" && window.innerWidth <= 1100;

/**
 * 右の欄。参加前は「フレンドの今」と通知、セッション内は通知とチャット・通話の操作を置く。
 * チャット・メッセージ・ログ・通話は、まだ仕組みがないのでボタンだけ置く（ADR 0063）。
 */
export function RightPanel({ inSession }: { inSession: boolean }) {
  const editing = useWorkspace((s) => !!s.project && !s.panelsHidden);
  const [collapsed, setCollapsed] = useState(() => editing || narrow());
  // 制作を始めたらたたみ、やめたら開く（狭い画面ではたたんだまま）
  const [wasEditing, setWasEditing] = useState(editing);
  if (wasEditing !== editing) {
    setWasEditing(editing);
    setCollapsed(editing || narrow());
  }
  const notices = useNoticeCount();
  // 画面いっぱいのページが、右の欄の下に隠れないよう幅を測る（たたむと幅が変わる）
  const ref = useRef<HTMLElement>(null);
  useLayoutEdge(ref);
  // biome-ignore lint/correctness/useExhaustiveDependencies: たたむ・開くで要素が入れ替わるので測り直す
  useLayoutEffect(updateLayoutEdges, [collapsed]);
  if (collapsed)
    return (
      <aside
        ref={ref}
        data-app-edge-right
        className={`glass ${styles.rail}`}
        aria-label={inSession ? "通知とチャット（たたんでいる）" : "右の欄（たたんでいる）"}
      >
        <button
          type="button"
          className={styles.icon}
          aria-label={inSession ? "通知とチャットを開く" : "右の欄を開く"}
          title="開く"
          onClick={() => setCollapsed(false)}
        >
          ‹
        </button>
        <button
          type="button"
          className={styles.icon}
          aria-label={`通知 ${notices} 件`}
          title="通知"
          onClick={() => setCollapsed(false)}
        >
          <BellIcon />
          {notices > 0 && <i className={styles.dot} aria-hidden="true" />}
        </button>
        {inSession && (
          <>
            <button type="button" className={styles.icon} aria-label="チャット" title="チャット">
              <ChatIcon />
            </button>
            <span className={styles.rule} aria-hidden="true" />
            <button type="button" className={styles.icon} aria-label="マイク" title="マイク">
              <MicIcon />
            </button>
          </>
        )}
      </aside>
    );
  return (
    <aside
      ref={ref}
      data-app-edge-right
      className={`glass ${styles.panel}`}
      aria-label={inSession ? "通知とチャット" : "右の欄"}
    >
      <div className={styles.head}>
        {inSession ? <h2>通知</h2> : <FriendsNowTitle />}
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.icon}
          aria-label="右の欄をたたむ"
          title="たたむ"
          onClick={() => setCollapsed(true)}
        >
          ›
        </button>
      </div>
      {inSession ? (
        <>
          <Notices />
          <Chat />
          <Dock />
        </>
      ) : (
        <>
          <FriendsNow />
          <div className={styles.section}>
            <h3 className={styles.label}>通知</h3>
            <Notices />
          </div>
        </>
      )}
    </aside>
  );
}

function useNoticeCount() {
  return useSocial(
    (s) =>
      (s.data?.incoming.length ?? 0) +
      (s.data?.invitations.incoming.filter((i) => i.status === "pending").length ?? 0),
  );
}

function FriendsNowTitle() {
  return (
    <button type="button" className={styles.titleButton}>
      フレンドの今
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

/** フレンドがいるセッション。押すとセッションのウィンドウで選ぶ */
function FriendsNow() {
  const friends = useSocial((s) => s.data?.friends);
  const loading = useSocial((s) => s.loading);
  const rooms = [
    ...new Map((friends ?? []).flatMap((f) => f.presence.sessions).map((s) => [s.id, s])).values(),
  ];
  if (!friends)
    return (
      <p className={styles.empty}>
        {loading ? "読み込んでいます…" : "フレンドの場所を見られません"}
      </p>
    );
  if (!rooms.length)
    return <p className={styles.empty}>いまフレンドがいるセッションはありません。</p>;
  return (
    <ul className={styles.list} aria-label="フレンドがいるセッション">
      {rooms.map((room) => (
        <li key={room.id}>
          <button
            type="button"
            className={styles.row}
            onClick={() => {
              const menu = useMainMenu.getState();
              menu.setQuery("sessions", "");
              menu.select("sessions", room.id);
              menu.selectPage("sessions");
            }}
          >
            <span className={styles.thumb} aria-hidden="true" />
            <span className={styles.rowText}>
              <b>{room.name}</b>
              <span>
                {room.count}人 · {room.participants.map((p) => p.name).join("・")}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 届いた招待とフレンド申請 */
function Notices() {
  const data = useSocial((s) => s.data);
  const busy = useSocial((s) => s.busy);
  const online = useApp((s) => s.status === "online");
  const invites = (data?.invitations.incoming ?? []).filter((i) => i.status === "pending");
  const requests = data?.incoming ?? [];
  if (!invites.length && !requests.length)
    return <p className={styles.empty}>新しい通知はありません。</p>;
  return (
    <ul className={styles.notices} aria-label="通知">
      {invites.map((invite) => (
        <li key={invite.id} className={styles.notice}>
          <span className={styles.avatar}>{invite.from?.name.slice(0, 1) ?? "?"}</span>
          <span className={styles.noticeText}>
            <b>{invite.from?.name ?? "相手"}</b> が「{invite.session?.name ?? "終了したセッション"}
            」に誘っています
          </span>
          <button
            type="button"
            className={styles.primary}
            disabled={busy || !online || !invite.session}
            onClick={() => void acceptInvitation(invite)}
          >
            参加
          </button>
        </li>
      ))}
      {requests.map(({ user }) => (
        <li key={user.id} className={styles.notice}>
          <span className={styles.avatar}>{user.name.slice(0, 1)}</span>
          <span className={styles.noticeText}>
            <b>{user.name}</b> からフレンド申請が届いています
          </span>
          <button
            type="button"
            className={styles.button}
            onClick={() => useMainMenu.getState().selectPage("friends")}
          >
            見る
          </button>
        </li>
      ))}
    </ul>
  );
}

/** チャット・メッセージ・ログ。まだ仕組みがないので、見た目とボタンだけ置く */
function Chat() {
  return (
    <div className={styles.chat}>
      <div className={styles.tabs}>
        <button type="button" aria-pressed="true">
          チャット
        </button>
        <button type="button" aria-pressed="false">
          メッセージ
        </button>
        <button type="button" aria-pressed="false">
          ログ
        </button>
      </div>
      <p className={styles.chatEmpty}>チャットはまだ使えません。</p>
      <div className={styles.compose}>
        <div className={styles.range}>
          <span>声の範囲</span>
          <b>全体</b>
        </div>
        <div className={styles.composeRow}>
          <input
            aria-label="チャットに送信"
            placeholder="チャットはまだ使えません"
            disabled
            className={styles.input}
          />
          <button type="button" className={styles.send} aria-label="送信">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 12l16-8-6 16-2-7z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/** 通話の操作。まだ通話がないので、ボタンだけ置く */
function Dock() {
  return (
    <div className={styles.dock}>
      <button type="button" aria-label="マイク" title="マイク">
        <MicIcon />
      </button>
      <button type="button" aria-label="サウンドボード" title="サウンドボード">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" />
          <path d="M8 14s1 3 4 3 4-3 4-3M8 9h.01M16 9h.01" />
        </svg>
      </button>
      <button type="button" aria-label="音量" title="音量">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
        </svg>
      </button>
    </div>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 5h16v11H9l-5 4z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
