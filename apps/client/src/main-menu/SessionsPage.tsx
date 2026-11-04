import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../app/store";
import styles from "./MainMenu.module.css";
import { enterSession } from "./sessionActions";
import { useMainMenu } from "./store";

export function SessionsPage() {
  const { sessions, sessionsLoaded, session, status, myName, client, me } = useApp();
  const { queries, selected, pendingSession, sessionError } = useMainMenu();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(`${myName} の作業部屋`);
  const navigate = useNavigate();
  const query = queries.sessions.trim().toLocaleLowerCase();
  const list = sessions.filter((s) =>
    `${s.name} ${s.owner.name} ${s.participants.map((p) => p.name).join(" ")}`
      .toLocaleLowerCase()
      .includes(query),
  );
  const chosen = list.find((s) => s.id === selected.sessions) ?? list[0];
  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1>セッション</h1>
          <p className={styles.muted}>誰がいるかを見て、集まる場所を選ぶ。</p>
        </div>
        <button className={styles.primary} type="button" onClick={() => setCreating(!creating)}>
          セッションを作る
        </button>
      </div>
      {creating && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim())
              void enterSession({ t: "session.create", name: name.trim() }, navigate);
          }}
        >
          <label>
            セッションの名前
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required />
          </label>
          <button
            className={styles.primary}
            type="submit"
            disabled={status !== "online" || pendingSession}
          >
            作って参加する
          </button>
        </form>
      )}
      <div className={styles.toolbar}>
        <input
          aria-label="セッションを検索"
          placeholder="セッション名・参加者で検索"
          value={queries.sessions}
          onChange={(e) => useMainMenu.getState().setQuery("sessions", e.target.value)}
        />
        <button
          className={styles.button}
          type="button"
          disabled={status !== "online"}
          onClick={() => client.send({ t: "sessions.list" })}
        >
          更新
        </button>
      </div>
      {sessionError && (
        <p role="alert" className={styles.error}>
          {sessionError}
        </p>
      )}
      {status !== "online" && (
        <p role="status" className={styles.notice}>
          接続を確認しています。表示内容は最後に受け取ったものです。
        </p>
      )}
      {!sessionsLoaded ? (
        <p role="status">セッションを読み込んでいます…</p>
      ) : (
        <div className={styles.split}>
          <div className={styles.list}>
            {list.length === 0 && (
              <p className={styles.empty}>
                {query
                  ? "検索に一致するセッションはありません。"
                  : "開いているセッションはありません。新しく作れます。"}
              </p>
            )}
            {list.map((s) => (
              <button
                type="button"
                key={s.id}
                className={styles.listCard}
                aria-pressed={chosen?.id === s.id}
                onClick={() => useMainMenu.getState().select("sessions", s.id)}
              >
                <span className={styles.eyebrow}>
                  {session?.id === s.id ? "参加中" : `${s.count}人が参加中`}
                </span>
                <strong>{s.name}</strong>
                <span className={styles.muted}>
                  {s.participants.map((p) => p.name).join("・") || "参加者を待っています"}
                </span>
              </button>
            ))}
          </div>
          {chosen && (
            <aside className={styles.detail} aria-label="セッションの詳細">
              <span className={styles.eyebrow}>セッション</span>
              <h2>{chosen.name}</h2>
              <p className={styles.muted}>持ち主: {chosen.owner.name}</p>
              <h3>参加者 {chosen.count}人</h3>
              <ul className={styles.people}>
                {chosen.participants.map((p) => (
                  <li key={p.id}>
                    <span className={styles.avatar}>{p.name.slice(0, 1)}</span>
                    {p.name}
                    {p.id === chosen.owner.id && <small>持ち主</small>}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={styles.primary}
                disabled={status !== "online" || pendingSession}
                onClick={() =>
                  void enterSession({ t: "session.join", sessionId: chosen.id }, navigate)
                }
              >
                {pendingSession
                  ? "参加しています…"
                  : session?.id === chosen.id
                    ? "このセッションに戻る"
                    : session
                      ? "このセッションに移動する"
                      : "このセッションに参加する"}
              </button>
              {session?.id === chosen.id && (
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => {
                    if (session.owner === me?.id) {
                      if (
                        window.confirm(
                          "セッションを閉じますか？ 参加中の全員が退出します。作ったプロジェクトは残ります。",
                        )
                      )
                        client.send({ t: "session.close" });
                    } else navigate("/");
                  }}
                >
                  {session.owner === me?.id ? "セッションを閉じる" : "セッションを出る"}
                </button>
              )}
            </aside>
          )}
        </div>
      )}
    </>
  );
}
