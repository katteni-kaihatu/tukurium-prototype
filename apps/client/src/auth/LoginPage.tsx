import { useState } from "react";
import { type AuthState, devLogin, loginWithMisskey } from "./auth";
import styles from "./LoginPage.module.css";

/** ログインの画面（ADR 0074）。ログインしていないときは、ここだけを出す */
export function LoginPage({ auth, onLoggedIn }: { auth: AuthState; onLoggedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-label="ログイン">
        <h1 className={styles.logo}>ツクリウム</h1>
        <p className={styles.lead}>みんなで、空間の中でアイテムやワールドを作る場所。</p>
        <button
          type="button"
          className={styles.primary}
          disabled={busy}
          onClick={() => void run(loginWithMisskey)}
        >
          Misskey でログイン
        </button>
        <p className={styles.note}>
          {auth.misskeyHost} のアカウントで入ります。読むのはアカウントの名前とアイコンだけです。
        </p>
        {auth.devLogin && (
          <form
            className={styles.dev}
            aria-label="開発用ログイン"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void run(async () => {
                await devLogin(name.trim());
                onLoggedIn();
              });
            }}
          >
            <span className={styles.devLabel}>開発用ログイン（手元とテストだけ）</span>
            <div className={styles.devRow}>
              <input
                value={name}
                maxLength={32}
                placeholder="名前"
                aria-label="開発用の名前"
                onChange={(e) => setName(e.target.value)}
              />
              <button type="submit" className={styles.button} disabled={busy || !name.trim()}>
                名前で入る
              </button>
            </div>
          </form>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
