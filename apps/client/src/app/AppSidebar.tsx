import { useEffect, useState } from "react";
import { useCatalog } from "../main-menu/catalogStore";
import { MenuIcon } from "../main-menu/MenuIcon";
import { useSocial } from "../main-menu/socialStore";
import { useMainMenu } from "../main-menu/store";
import styles from "./AppSidebar.module.css";

const ENTRIES = [
  ["friends", "フレンド"],
  ["sessions", "セッション"],
  ["items", "アイテム"],
  ["market", "マーケット"],
  ["projects", "プロジェクト"],
  ["library", "ライブラリ"],
] as const;

/** セッションへの参加に関係なく使える、アプリ全体の入口。 */
export function AppSidebar() {
  const [locked, setLocked] = useState(() => document.pointerLockElement !== null);
  useEffect(() => {
    const update = () => setLocked(document.pointerLockElement !== null);
    update();
    document.addEventListener("pointerlockchange", update);
    return () => document.removeEventListener("pointerlockchange", update);
  }, []);
  const windows = useMainMenu((s) => s.windows);
  const owned = useCatalog((s) => s.owned.length);
  const unread = useSocial(
    (s) =>
      (s.data?.incoming.length ?? 0) +
      (s.data?.invitations.incoming.filter((i) => i.status === "pending").length ?? 0),
  );
  return (
    <aside className={`glass ${styles.sidebar}`} aria-label="アプリ全体" data-labels={!locked}>
      <nav className={styles.nav} aria-label="アプリの画面">
        {ENTRIES.map(([id, label]) => {
          const count = id === "friends" ? unread : id === "items" ? owned : 0;
          return (
            <button
              key={id}
              type="button"
              aria-label={label}
              title={locked ? label : undefined}
              data-window-button={id}
              aria-pressed={windows[id].open}
              onClick={() => useMainMenu.getState().showWindow(id)}
            >
              <MenuIcon page={id} />
              <span className={styles.label}>{label}</span>
              {count > 0 && (
                <span className={styles.badge} aria-hidden="true">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
