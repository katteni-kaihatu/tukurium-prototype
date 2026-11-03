import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Header } from "../app/Header";
import { useApp } from "../app/store";
import { api, type RepoMeta, type Work } from "../net/api";
import styles from "./pages.module.css";

/** プロフィール：その人のプロジェクトと作品（/u/me は自分） */
export function ProfilePage() {
  const { userId = "" } = useParams();
  const me = useApp((s) => s.me);
  const id = userId === "me" ? me?.id : userId;
  const [user, setUser] = useState<{
    id: string;
    name: string;
    repos: RepoMeta[];
    works: Work[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (id && me) api.user(id).then(setUser, (e: Error) => setError(e.message));
  }, [id, me]);

  return (
    <div className={styles.page}>
      <Header />
      <main className={styles.main}>
        {error && <p className={styles.error}>{error}</p>}
        {user && (
          <div className={styles.grid} style={{ gridTemplateColumns: "260px minmax(0, 1fr)" }}>
            <aside className={styles.card}>
              <h1 className={styles.title}>{user.name}</h1>
              <p className={styles.sub}>[ひとことプロフィールを記入]</p>
              {user.id === me?.id && (
                <Link to="/new" className={styles.primary}>
                  ＋ 新しいプロジェクト
                </Link>
              )}
            </aside>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
              <section className={styles.card} aria-label="プロジェクト">
                <h2 className={styles.h2}>Projects · {user.repos.length}</h2>
                <ul className={styles.list}>
                  {user.repos.length === 0 && <li className={styles.sub}>まだありません</li>}
                  {user.repos.map((r) => (
                    <li key={r.id}>
                      <Link className={`${styles.link} ${styles.grow}`} to={`/p/${r.id}`}>
                        {r.name}
                      </Link>
                      {r.forkedFrom && (
                        <span className={styles.sub}>Forked from {r.forkedFrom.repoName}</span>
                      )}
                      <span className={styles.badge}>
                        {r.visibility === "public" ? "Public" : "Private"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className={styles.card} aria-label="作品">
                <h2 className={styles.h2}>作品 · {user.works.length}</h2>
                <ul className={styles.list}>
                  {user.works.length === 0 && <li className={styles.sub}>まだありません</li>}
                  {user.works.map((w) => (
                    <li key={w.id}>
                      <Link className={`${styles.link} ${styles.grow}`} to={`/p/${w.repoId}`}>
                        {w.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
              <section className={styles.card} aria-label="活動">
                <h2 className={styles.h2}>Contribution activity</h2>
                <p className={styles.sub}>草グラフ・フォロワーは初版では見た目だけです。</p>
              </section>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
