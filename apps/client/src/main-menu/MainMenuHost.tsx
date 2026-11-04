import { useEffect, useLayoutEffect, useRef } from "react";
import { useApp } from "../app/store";
import { PanelLayer, type PanelSpec } from "../panels/PanelLayer";
import { CatalogPage } from "./CatalogPage";
import { useCatalogConnection } from "./catalogStore";
import styles from "./MainMenu.module.css";
import { SessionsPage } from "./SessionsPage";
import { useSessionLifecycle } from "./sessionActions";
import { MENU_PAGES, useMainMenu } from "./store";

/** ルート切替の外に置き、同じウィンドウと表示状態を保つ。 */
export function MainMenuHost() {
  useSessionLifecycle();
  useCatalogConnection();
  const { open, engine, recall } = useMainMenu();
  useEffect(() => {
    if (!open) return;
    if (document.pointerLockElement) document.exitPointerLock();
    engine?.controller.clearInput();
    document.querySelector<HTMLElement>('[aria-label="メインメニュー"]')?.focus();
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
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = useMainMenu.getState().scroll[page] ?? 0;
  }, [page]);
  const session = useApp((s) => s.session);
  const name = useApp((s) => s.myName);
  return (
    <div
      className={styles.menu}
      role="dialog"
      aria-label="メインメニュー"
      tabIndex={-1}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
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
              aria-current={page === id ? "page" : undefined}
              onClick={() => useMainMenu.getState().selectPage(id)}
            >
              {title}
            </button>
          ))}
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
              {id === "items" || id === "market" ? (
                <CatalogPage kind={id} active={page === id} />
              ) : id === "sessions" ? (
                <SessionsPage />
              ) : (
                <>
                  <h1>{title}</h1>
                  <p className={styles.muted}>
                    {id === "home"
                      ? "集まる場所や、持ち込むアイテムをここから選びます。"
                      : "この画面は次の実装単位で実データにつなぎます。"}
                  </p>
                </>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
