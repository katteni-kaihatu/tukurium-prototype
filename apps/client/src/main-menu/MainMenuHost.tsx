import { useEffect, useLayoutEffect, useRef } from "react";
import { useApp } from "../app/store";
import { PanelLayer, type PanelSpec } from "../panels/PanelLayer";
import { CatalogPage } from "./CatalogPage";
import { useCatalog, useCatalogConnection } from "./catalogStore";
import { FriendsPage } from "./FriendsPage";
import { HomeHub } from "./HomeHub";
import styles from "./MainMenu.module.css";
import { MenuShortcuts } from "./MenuShortcuts";
import { SessionsPage } from "./SessionsPage";
import { useSessionLifecycle } from "./sessionActions";
import { useSocial, useSocialConnection } from "./socialStore";
import { MENU_PAGES, useMainMenu } from "./store";

/** ルート切替の外に置き、同じウィンドウと表示状態を保つ。 */
export function MainMenuHost() {
  useSessionLifecycle();
  useCatalogConnection();
  useSocialConnection();
  const { open, engine, recall } = useMainMenu();
  useEffect(() => {
    if (!open) return;
    if (document.pointerLockElement) document.exitPointerLock();
    engine?.controller.clearInput();
    document
      .querySelector<HTMLElement>('[role="dialog"][aria-label="ツクリウム メニュー"]')
      ?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      useMainMenu.getState().close();
      document.querySelector<HTMLButtonElement>('[aria-label="ツクリウム メニュー"]')?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, engine]);
  const panels: PanelSpec[] = [
    {
      id: "main-menu",
      title: "ツクリウム メニュー",
      containKeys: true,
      initial: { x: 36, y: 88, width: 1040, height: 650 },
      recallKey: recall,
      focusKey: recall,
      onClose: () => useMainMenu.getState().close(),
      render: () => <MainMenu />,
    },
  ];
  return <PanelLayer engine={engine} panels={panels} hidden={!open} layer={4} />;
}

function MainMenu() {
  const page = useMainMenu((s) => s.page);
  const owner = useApp((s) => s.me?.id);
  const ownedCount = useCatalog((s) => s.owned.length);
  const unread = useSocial(
    (s) =>
      (s.data?.incoming.length ?? 0) +
      (s.data?.invitations.incoming.filter((i) => i.status === "pending").length ?? 0),
  );
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = useMainMenu.getState().scroll[page] ?? 0;
  }, [page]);
  const session = useApp((s) => s.session);
  const name = useApp((s) => s.myName);
  return (
    <div className={styles.menu}>
      <div className={styles.location}>
        <div>
          <span className={styles.caption}>現在の場所</span>
          <strong>{session?.name ?? "セッション未参加"}</strong>
        </div>
        <span className={styles.profile}>{name}</span>
      </div>
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label="メニューの画面">
          {MENU_PAGES.map(([id, title]) => (
            <button
              key={id}
              type="button"
              aria-label={title}
              aria-current={page === id ? "page" : undefined}
              onClick={() => useMainMenu.getState().selectPage(id)}
            >
              {title}
              {(id === "friends" ? unread : id === "items" ? ownedCount : 0) > 0 && (
                <span className={styles.navBadge} aria-hidden="true">
                  {id === "friends" ? unread : ownedCount}
                </span>
              )}
            </button>
          ))}
          <MenuShortcuts />
        </nav>
        <div
          ref={content}
          className={styles.content}
          onScroll={(event) =>
            useMainMenu.setState((s) => ({
              scroll: { ...s.scroll, [page]: event.currentTarget.scrollTop },
            }))
          }
        >
          {MENU_PAGES.map(([id, title]) => (
            <section key={id} hidden={page !== id} aria-label={title}>
              {id === "home" ? (
                <HomeHub key={owner} active={page === id} />
              ) : id === "friends" ? (
                <FriendsPage key={owner} active={page === id} />
              ) : id === "items" || id === "market" ? (
                <CatalogPage kind={id} active={page === id} />
              ) : id === "sessions" ? (
                <SessionsPage />
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
