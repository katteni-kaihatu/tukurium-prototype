import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AvatarFace } from "../app/AvatarFace";
import { useApp } from "../app/store";
import { api, type PersonResult } from "../net/api";
import { Invitations } from "./Invitations";
import styles from "./MainMenu.module.css";
import { StatusBadge } from "./StatusPanel";
import { enterSession } from "./sessionActions";
import { changeSocial, refreshSocial, useSocial } from "./socialStore";
import { useMainMenu } from "./store";

export function FriendsPage({ active }: { active: boolean }) {
  const { data, loading, error, busy } = useSocial();
  const { me, status, session } = useApp();
  const menu = useMainMenu();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [people, setPeople] = useState<PersonResult[]>([]);
  const [search, setSearch] = useState("");
  const [finding, setFinding] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  useEffect(() => {
    const query = search.trim();
    if (!active || !adding || !query || !menu.open) {
      setPeople([]);
      setFinding(false);
      return;
    }
    const abort = new AbortController();
    let live = true;
    setFinding(true);
    setSearchError(null);
    const timer = setTimeout(
      () =>
        void api
          .people(query, abort.signal)
          .then(
            (result) => {
              if (live) setPeople(result);
            },
            (e: unknown) => {
              if (live) setSearchError(e instanceof Error ? e.message : "検索できませんでした");
            },
          )
          .finally(() => {
            if (live) setFinding(false);
          }),
      200,
    );
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [active, adding, search, menu.open]);
  const query = menu.queries.friends.toLocaleLowerCase();
  const friends = (data?.friends ?? []).filter((f) =>
    f.user.name.toLocaleLowerCase().includes(query),
  );
  const chosen = friends.find((f) => f.user.id === menu.selected.friends) ?? friends[0];
  const connected = status === "online";
  const perform = (action: () => Promise<unknown>) => void changeSocial(action);
  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1>フレンド</h1>
          <p className={styles.muted}>いまの様子と、集まっている場所を見る。</p>
        </div>
        <button type="button" className={styles.primary} onClick={() => setAdding(!adding)}>
          フレンドを追加
        </button>
      </div>
      {/* 表示の切り替え。いまは「すべて」だけで、ほかはボタンだけ置く（ADR 0064） */}
      <div className={styles.tabs}>
        {["すべて", "フレンドの今", "フォロワー", "フォロー中", "ブロック中"].map((label, i) => (
          <button key={label} type="button" aria-pressed={i === 0}>
            {label}
          </button>
        ))}
      </div>
      <div className={styles.myStatus}>
        <div>
          <span className={styles.caption}>自分の状態</span>
          <StatusBadge availability={data?.profile.availability ?? "online"} online={connected} />
          {data?.profile.note && <span>{data.profile.note}</span>}
        </div>
        <button
          className={styles.button}
          type="button"
          data-window-button="status"
          aria-haspopup="dialog"
          disabled={!data || !connected}
          onClick={() => {
            useSocial.setState({ error: null });
            menu.showWindow("status");
          }}
        >
          ステータスを変更
        </button>
      </div>
      <p className={styles.caption}>
        あなたのユーザーID: <code>{me?.id}</code>
      </p>
      {adding && (
        <div className={styles.searchPeople}>
          <label>
            名前かユーザーIDで探す
            <input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={80} />
          </label>
          {finding && <p role="status">探しています…</p>}
          {searchError && (
            <p className={styles.error} role="alert">
              {searchError}
            </p>
          )}
          {!finding && search.trim() && people.length === 0 && !searchError && (
            <p>見つかりませんでした。</p>
          )}
          {people.map((p) => (
            <div key={p.user.id} className={styles.personResult}>
              <span>
                <strong>{p.user.name}</strong>
                <small>{p.user.id}</small>
              </span>
              <button
                className={styles.button}
                type="button"
                disabled={
                  busy || !connected || p.relation === "friend" || p.relation === "outgoing"
                }
                onClick={() =>
                  perform(async () => {
                    if (p.relation === "incoming") await api.acceptFriend(p.user.id);
                    else await api.requestFriend(p.user.id);
                    setSearch("");
                  })
                }
              >
                {p.relation === "friend"
                  ? "フレンド"
                  : p.relation === "outgoing"
                    ? "申請中"
                    : p.relation === "incoming"
                      ? "承認する"
                      : "申請する"}
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {menu.sessionError && (
        <p className={styles.error} role="alert">
          {menu.sessionError}
        </p>
      )}
      {!connected && (
        <p className={styles.notice} role="status">
          接続を確認しています。状態は最後に受け取ったものです。
        </p>
      )}
      {!!data?.incoming.length && (
        <section className={styles.requests} aria-label="届いたフレンド申請">
          <h2>届いた申請</h2>
          {data.incoming.map(({ user }) => (
            <article key={user.id} className={styles.personResult}>
              <strong>{user.name}</strong>
              <div className={styles.inlineActions}>
                <button
                  className={styles.primary}
                  type="button"
                  disabled={busy || !connected}
                  onClick={() => perform(() => api.acceptFriend(user.id))}
                >
                  承認する
                </button>
                <button
                  className={styles.button}
                  type="button"
                  disabled={busy || !connected}
                  onClick={() => perform(() => api.removeFriend(user.id))}
                >
                  辞退する
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
      {!!data?.outgoing.length && (
        <section className={styles.requests} aria-label="送ったフレンド申請">
          <h2>送った申請</h2>
          {data.outgoing.map(({ user }) => (
            <article key={user.id} className={styles.personResult}>
              <strong>{user.name}</strong>
              <button
                className={styles.button}
                type="button"
                disabled={busy || !connected}
                onClick={() => perform(() => api.removeFriend(user.id))}
              >
                申請を取り消す
              </button>
            </article>
          ))}
        </section>
      )}
      <Invitations />
      <div className={styles.toolbar}>
        <input
          aria-label="フレンドを検索"
          placeholder="フレンドを検索"
          value={menu.queries.friends}
          onChange={(e) => menu.setQuery("friends", e.target.value)}
        />
        <button
          className={styles.button}
          type="button"
          disabled={!connected}
          onClick={() => void refreshSocial()}
        >
          更新
        </button>
      </div>
      {loading && !data ? (
        <p role="status">フレンドを読み込んでいます…</p>
      ) : !data ? null : (
        <div className={styles.split}>
          <div className={styles.list}>
            {friends.length === 0 && (
              <p className={styles.empty}>
                {query
                  ? "一致するフレンドはいません。"
                  : "まだフレンドはいません。名前やユーザーIDで探して申請できます。"}
              </p>
            )}
            {friends.map((f) => (
              <button
                type="button"
                key={f.user.id}
                className={`${styles.listCard} ${styles.friendCard}`}
                aria-pressed={chosen?.user.id === f.user.id}
                onClick={() => menu.select("friends", f.user.id)}
              >
                <span
                  className={styles.avatar}
                  data-status={f.presence.online ? f.profile.availability : "offline"}
                >
                  <AvatarFace user={f.user} />
                </span>
                <span className={styles.friendText}>
                  <strong>{f.user.name}</strong>
                  <span className={styles.caption}>
                    {f.presence.sessions.map((s) => `${s.name}にいます`).join("・") ||
                      (f.presence.online ? "セッション未参加" : "")}
                  </span>
                  <StatusBadge availability={f.profile.availability} online={f.presence.online} />
                  {f.profile.note && <span className={styles.caption}>{f.profile.note}</span>}
                </span>
              </button>
            ))}
          </div>
          {chosen && (
            <aside className={styles.detail} aria-label="フレンドの詳細">
              <span className={styles.avatar}>
                <AvatarFace user={chosen.user} />
              </span>
              <h2>{chosen.user.name}</h2>
              {chosen.user.account && <p className={styles.caption}>{chosen.user.account}</p>}
              <StatusBadge
                availability={chosen.profile.availability}
                online={chosen.presence.online}
              />
              {chosen.profile.note && <p>{chosen.profile.note}</p>}
              <h3>参加中のセッション</h3>
              {chosen.presence.sessions.length === 0 && (
                <p className={styles.muted}>いま参加している場所はありません。</p>
              )}
              {chosen.presence.sessions.map((s) => (
                <button
                  type="button"
                  className={styles.button}
                  key={s.id}
                  disabled={!connected || menu.pendingSession}
                  onClick={() =>
                    void enterSession({ t: "session.join", sessionId: s.id }, navigate)
                  }
                >
                  {s.name} に参加する
                </button>
              ))}
              <button
                type="button"
                className={styles.button}
                disabled={busy || !connected}
                onClick={() => {
                  if (window.confirm(`${chosen.user.name}とのフレンド関係を解除しますか？`))
                    perform(() => api.removeFriend(chosen.user.id));
                }}
              >
                フレンドを解除
              </button>
              {session && (
                <button
                  type="button"
                  className={styles.primary}
                  disabled={
                    busy || !connected || chosen.presence.sessions.some((s) => s.id === session.id)
                  }
                  onClick={() => perform(() => api.invite(chosen.user.id, session.id))}
                >
                  {chosen.presence.sessions.some((s) => s.id === session.id)
                    ? "同じセッションに参加中"
                    : "このセッションへ招待"}
                </button>
              )}
              {/* メッセージはまだ仕組みがないので、入力欄とボタンだけ置く */}
              <div className={styles.compose}>
                <input
                  aria-label={`${chosen.user.name} にメッセージを送信`}
                  placeholder="メッセージはまだ使えません"
                  disabled
                />
                <button type="button" className={styles.iconButton} aria-label="送信">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M4 12l16-8-6 16-2-7z" />
                  </svg>
                </button>
              </div>
            </aside>
          )}
        </div>
      )}
    </>
  );
}
