import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Header } from "../app/Header";
import { useApp } from "../app/store";
import { api, type RepoMeta, type Work } from "../net/api";
import { ProjectLink as Link } from "./ProjectNavigation";
import styles from "./pages.module.css";

/** プロフィール：その人のプロジェクトとリリース（/u/me は自分） */
export function ProfilePage({
  embedded = false,
  profileId,
}: {
  embedded?: boolean;
  profileId?: string;
}) {
  const params = useParams();
  const userId = profileId ?? params.userId ?? "";
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
    let active = true;
    setUser(null);
    setError(null);
    if (id && me)
      void api.user(id).then(
        (value) => {
          if (active) setUser(value);
        },
        (e: Error) => {
          if (active) setError(e.message);
        },
      );
    return () => {
      active = false;
    };
  }, [id, me]);

  return (
    <div className={embedded ? styles.embedded : styles.page}>
      {!embedded && <Header />}
      <main className={embedded ? styles.embeddedMain : styles.main}>
        {error && <p className={styles.error}>{error}</p>}
        {user && (
          <div className={`${styles.grid} ${styles.profileGrid}`}>
            <aside className={styles.card}>
              <h1 className={styles.title}>{user.name}</h1>
              <p className={styles.sub}>
                {user.id === me?.id ? "自分のプロジェクトとリリース" : "プロジェクトとリリース"}
              </p>
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
              <section className={styles.card} aria-label="リリース">
                <h2 className={styles.h2}>リリース · {user.works.length}</h2>
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
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
