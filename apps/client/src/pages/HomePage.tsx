import { useEffect } from "react";
import { Header } from "../app/Header";
import { useMainMenu } from "../main-menu/store";
import styles from "./HomePage.module.css";

/** 参加前も、左上から開く共通メニューを入口にする。 */
export function HomePage() {
  const open = useMainMenu((s) => s.open);
  useEffect(() => {
    useMainMenu.getState().show("home");
  }, []);
  return (
    <div className={styles.page}>
      <Header />
      {!open && (
        <main className={styles.main}>
          <section className={styles.card}>
            <h1 className={styles.title}>ツクリウム</h1>
            <p className={styles.lead}>集まる場所や、使いたいアイテムを探す。</p>
            <button
              type="button"
              className={styles.primary}
              onClick={() => useMainMenu.getState().show()}
            >
              メニューを開く
            </button>
          </section>
        </main>
      )}
    </div>
  );
}
