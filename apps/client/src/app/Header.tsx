import styles from "./Header.module.css";
import { useSession } from "./store";

const NAV = ["作る", "探す", "ライブラリ"] as const;

export function Header() {
  const { myName, status, participants } = useSession();
  const others = Object.values(participants);

  return (
    <header className={`glass ${styles.header}`}>
      <div className={styles.brand}>
        <span className={styles.logo} aria-hidden="true" />
        <span className={styles.wordmark}>ツクリウム</span>
      </div>
      <nav aria-label="メイン" className={styles.nav}>
        {NAV.map((label, i) => (
          <button
            key={label}
            type="button"
            aria-current={i === 0 ? "page" : undefined}
            className={i === 0 ? styles.navActive : styles.navItem}
          >
            {label}
          </button>
        ))}
      </nav>
      <span className={styles.divider} />
      <div className={styles.spacer} />
      <ul className={styles.people} aria-label="セッションの参加者">
        <li className={styles.person}>
          <span className={styles.initial}>{myName.slice(0, 1)}</span>
          <span>{myName}</span>
          <span className={styles.you}>あなた</span>
        </li>
        {others.map((p) => (
          <li key={p.id} className={styles.person}>
            <span className={`${styles.initial} ${styles.initialOther}`}>{p.name.slice(0, 1)}</span>
            <span>{p.name}</span>
          </li>
        ))}
      </ul>
      <span className={styles.status} data-status={status} title="サーバーとの接続">
        {status === "online"
          ? "接続中"
          : status === "connecting"
            ? "接続しています…"
            : "オフライン"}
      </span>
    </header>
  );
}
