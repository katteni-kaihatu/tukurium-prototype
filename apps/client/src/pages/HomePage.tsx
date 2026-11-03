import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Header } from "../app/Header";
import { useApp } from "../app/store";
import styles from "./HomePage.module.css";

/** ホーム：名前の設定、セッションを作る・開いているセッションに参加する */
export function HomePage() {
  const { client, myName, setName, sessions, session, closedReason, status } = useApp();
  const navigate = useNavigate();
  const nameId = useId();
  const sessionNameId = useId();
  const [name, setDraftName] = useState(myName);
  const [sessionName, setSessionName] = useState(`${myName} の作業部屋`);
  const [creating, setCreating] = useState(false);

  useEffect(() => setDraftName(myName), [myName]);

  // 作ったセッションに入る
  useEffect(() => {
    if (creating && session) navigate(`/s/${session.id}`);
  }, [creating, session, navigate]);

  // ホームにいる間はセッションに参加しない
  useEffect(() => client.onWelcome(() => client.send({ t: "sessions.list" })), [client]);

  return (
    <div className={styles.page}>
      <Header />
      <main className={styles.main}>
        {closedReason && <p className={styles.notice}>{closedReason}</p>}
        <section className={styles.card} aria-labelledby="home-create">
          <h1 id="home-create" className={styles.title}>
            セッションを作る
          </h1>
          <p className={styles.lead}>
            セッションは、ワールドを開いて交流・制作する場所です。作った人が閉じるとなくなります。
          </p>
          <div className={styles.field}>
            <label htmlFor={nameId}>あなたの名前</label>
            <input
              id={nameId}
              value={name}
              maxLength={32}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => name.trim() && name !== myName && setName(name.trim())}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={sessionNameId}>セッションの名前</label>
            <input
              id={sessionNameId}
              value={sessionName}
              maxLength={64}
              onChange={(e) => setSessionName(e.target.value)}
            />
          </div>
          <button
            type="button"
            className={styles.primary}
            disabled={status !== "online" || !sessionName.trim()}
            onClick={() => {
              if (name.trim() && name !== myName) setName(name.trim());
              setCreating(true);
              client.send({ t: "session.create", name: sessionName.trim() });
            }}
          >
            セッションを作って入る
          </button>
        </section>

        <section className={styles.card} aria-labelledby="home-projects">
          <h2 id="home-projects" className={styles.title}>
            プロジェクト
          </h2>
          <p className={styles.lead}>
            作ったものはプロジェクトにコミットして残し、作品として公開できます。
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link
              to="/new"
              className={styles.primary}
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              ＋ 新しいプロジェクト
            </Link>
            <Link to="/u/me" className={styles.item} style={{ minHeight: 44 }}>
              自分のプロジェクト
            </Link>
            <Link to="/explore" className={styles.item} style={{ minHeight: 44 }}>
              作品を探す
            </Link>
          </div>
        </section>

        <section className={styles.card} aria-labelledby="home-list">
          <h2 id="home-list" className={styles.title}>
            開いているセッション
          </h2>
          {sessions.length === 0 ? (
            <p className={styles.lead}>いま開いているセッションはありません。</p>
          ) : (
            <ul className={styles.list}>
              {sessions.map((s) => (
                <li key={s.id}>
                  <Link to={`/s/${s.id}`} className={styles.item}>
                    <b>{s.name}</b>
                    <span>
                      {s.owner.name} · {s.count}人
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
