import { useEffect, useLayoutEffect, useRef } from "react";
import { useApp } from "../app/store";
import { PanelLayer, type PanelSpec, panelViewportInsets } from "../panels/PanelLayer";
import { LibraryPanel } from "../workspace/LibraryPanel";
import { CatalogPage } from "./CatalogPage";
import { useCatalogConnection } from "./catalogStore";
import { FriendsPage } from "./FriendsPage";
import { HomeHub } from "./HomeHub";
import styles from "./MainMenu.module.css";
import { OwnedItemsPage } from "./OwnedItemsPage";
import { ProjectBrowser } from "./ProjectBrowser";
import { SessionsPage } from "./SessionsPage";
import { useSessionLifecycle } from "./sessionActions";
import { useSocialConnection } from "./socialStore";
import { TOOL_WINDOWS, type ToolWindow, useMainMenu } from "./store";

/** 独立したウィンドウを同じ層で扱い、前後関係・位置・入力中の内容を保つ。 */
export function MainMenuHost() {
  useSessionLifecycle();
  useCatalogConnection();
  useSocialConnection();
  const { windows, engine, open, focusRequest } = useMainMenu();
  useEffect(() => {
    const id = focusRequest?.id;
    if (!id || !useMainMenu.getState().windows[id].open) return;
    if (document.pointerLockElement) document.exitPointerLock();
    engine?.controller.clearInput();
    document
      .querySelector<HTMLElement>(`[data-tool-window="${id}"]`)
      ?.closest<HTMLElement>('[role="dialog"]')
      ?.focus();
  }, [focusRequest, engine]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        document.querySelector("[data-workspace-popover], dialog[open]")
      )
        return;
      const id = useMainMenu.getState().activeWindow;
      if (!id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (id) useMainMenu.getState().close(id);
      document.querySelector<HTMLButtonElement>(`[data-window-button="${id}"]`)?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  const insets = panelViewportInsets();
  const panels: PanelSpec[] = TOOL_WINDOWS.map(([id, title], index) => ({
    id: `tool-${id}`,
    title,
    containKeys: true,
    hidden: !windows[id].open,
    initial: {
      x: insets.left + index * 20,
      y: insets.top + index * 10,
      width: id === "friends" ? 720 : 920,
      height: id === "items" ? 740 : 620,
    },
    recallKey: windows[id].recall,
    focusKey: windows[id].focus,
    onActivate: () => useMainMenu.getState().activate(id),
    onClose: () => useMainMenu.getState().close(id),
    render: () => (windows[id].focus > 0 ? <ToolContent id={id} /> : null),
  }));
  return <PanelLayer engine={engine} panels={panels} />;
}

function ToolContent({ id }: { id: ToolWindow }) {
  const owner = useApp((s) => s.me?.id);
  const session = useApp((s) => s.session);
  const visible = useMainMenu((s) => s.windows[id].open);
  const path = useMainMenu((s) => s.projectPath);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (id !== "projects" && id !== "workspaces" && id !== "library" && content.current)
      content.current.scrollTop = useMainMenu.getState().scroll[id] ?? 0;
  }, [id]);
  return (
    <div className={styles.menu} data-tool-window={id}>
      {id === "home" && (
        <div className={styles.windowContext}>
          <span>{session?.name ?? "セッション未参加"}</span>
          <button type="button" onClick={() => useMainMenu.getState().showProject("/workspaces")}>
            制作を始める
          </button>
        </div>
      )}
      <div
        className={styles.content}
        ref={content}
        onScroll={(event) => {
          if (id !== "projects" && id !== "workspaces" && id !== "library")
            useMainMenu.setState((s) => ({
              scroll: { ...s.scroll, [id]: event.currentTarget.scrollTop },
            }));
        }}
      >
        {id === "home" ? (
          <HomeHub key={owner} active={visible} />
        ) : id === "friends" ? (
          <FriendsPage key={owner} active={visible} />
        ) : id === "items" ? (
          <OwnedItemsPage />
        ) : id === "market" ? (
          <CatalogPage key={owner} active={visible} />
        ) : id === "sessions" ? (
          <SessionsPage />
        ) : id === "library" ? (
          <>
            <div className={styles.pageHeader}>
              <div>
                <h1>ライブラリ</h1>
                <p className={styles.muted}>公開された作品を、制作やセッションで使う。</p>
              </div>
            </div>
            <LibraryPanel active={visible} />
          </>
        ) : (
          <ProjectBrowser
            key={owner}
            path={id === "workspaces" ? "/workspaces" : (path ?? "/u/me")}
          />
        )}
      </div>
    </div>
  );
}
