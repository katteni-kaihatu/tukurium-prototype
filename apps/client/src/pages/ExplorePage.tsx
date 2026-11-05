import { useEffect, useState } from "react";
import { Header } from "../app/Header";
import { useApp } from "../app/store";
import { api, type RepoMeta, type Work } from "../net/api";
import { ProjectLink as Link } from "./ProjectNavigation";
import styles from "./pages.module.css";

/** 探す：公開されている作品とプロジェクト */
export function ExplorePage({ embedded = false }: { embedded?: boolean }) {
  const me = useApp((s) => s.me);
  const [works, setWorks] = useState<Work[]>([]);
  const [repos, setRepos] = useState<RepoMeta[]>([]);
  useEffect(() => {
    if (!me) return;
    void api.works().then(setWorks);
    void api.repos().then(setRepos);
  }, [me]);
  return (
    <div className={embedded ? styles.embedded : styles.page}>
      {!embedded && <Header />}
      <main className={embedded ? styles.embeddedMain : styles.main}>
        <section className={styles.card} aria-label="作品">
          <h1 className={styles.title}>作品</h1>
          <p className={styles.sub}>
            作品の中身や制作に使うプロジェクトを見られます。遊ぶアイテムはマーケットから入手できます。
          </p>
          <ul className={styles.list}>
            {works.length === 0 && <li className={styles.sub}>まだ公開された作品はありません</li>}
            {works.map((w) => (
              <li key={w.id}>
                <Link className={`${styles.link} ${styles.grow}`} to={`/p/${w.repoId}`}>
                  {w.name}
                </Link>
                <span className={styles.sub}>
                  {w.ownerName} / {w.repoName}
                </span>
                {w.latest && <span className={styles.badge}>v{w.latest.version}</span>}
              </li>
            ))}
          </ul>
        </section>
        <section className={styles.card} aria-label="プロジェクト">
          <h2 className={styles.h2}>プロジェクト</h2>
          <ul className={styles.list}>
            {repos.map((r) => (
              <li key={r.id}>
                <Link className={`${styles.link} ${styles.grow}`} to={`/p/${r.id}`}>
                  {r.ownerName} / {r.name}
                </Link>
                <span className={styles.sub}>{r.description}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
