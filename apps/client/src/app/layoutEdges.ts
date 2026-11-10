import { type RefObject, useLayoutEffect } from "react";

/**
 * 左のメニュー・欄と左上の札の大きさから、ウィンドウを置ける範囲を決める。
 * ウィンドウの初期位置と呼び戻し先は `--app-content-left` と `--app-panel-top` を避ける。
 */
export function updateLayoutEdges() {
  const root = document.documentElement;
  const nav = document.querySelector<HTMLElement>("[data-app-nav]");
  root.style.setProperty("--app-nav-right", `${nav?.getBoundingClientRect().right ?? 80}px`);
  let right = 16;
  for (const element of document.querySelectorAll<HTMLElement>("[data-app-edge]"))
    right = Math.max(right, element.getBoundingClientRect().right);
  root.style.setProperty("--app-content-left", `${right + 16}px`);
  const tag = document.querySelector<HTMLElement>("[data-session-bar]");
  root.style.setProperty(
    "--app-panel-top",
    `${(tag?.getBoundingClientRect().bottom ?? 60) + 12}px`,
  );
}

/** 要素の大きさが変わったとき・なくなったときに、置ける範囲を測り直す */
export function useLayoutEdge(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    updateLayoutEdges();
    const observer = new ResizeObserver(updateLayoutEdges);
    observer.observe(element);
    window.addEventListener("resize", updateLayoutEdges);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateLayoutEdges);
      requestAnimationFrame(updateLayoutEdges);
    };
  }, [ref]);
}
