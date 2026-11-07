import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

/**
 * ボタンの下（入りきらなければ上）に重ねて出す窓（メニュー・説明）の置き場所。
 *
 * - 2D のパネルでは、画面の上（document.body）に固定の位置で出す。パネルの枠で切れない。
 * - 3D に置いたパネルでは、そのパネルの入れ物の中に出す。画面の上に出すと、3D のパネルの前に
 *   平らな 2D の窓が浮いてしまうため。位置は CSS の変形の影響を受けないレイアウト上の px で決め、
 *   パネルの外は見えない（WebGL の穴の外）ので、パネルの中に収める。
 */
export function usePanelPopover(
  anchor: HTMLElement,
  box: RefObject<HTMLElement | null>,
  align: "start" | "end",
  gap = 4,
): { container: HTMLElement; style: CSSProperties } {
  const host = anchor.closest<HTMLElement>('[data-mode="3d"]');
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      let next: { top: number; left: number };
      if (host) {
        const at = layoutRect(anchor, host);
        if (!at) return;
        const room = { width: host.offsetWidth, height: host.offsetHeight };
        let top = at.top + at.height + gap;
        if (top + size.height > room.height - 4) top = at.top - gap - size.height;
        const raw = align === "start" ? at.left : at.left + at.width - size.width;
        next = {
          top: clamp(top, 4, room.height - size.height - 4),
          left: clamp(raw, 4, room.width - size.width - 4),
        };
      } else {
        const at = anchor.getBoundingClientRect();
        let top = at.bottom + gap;
        if (top + size.height > window.innerHeight - 8) {
          top = Math.max(8, at.top - gap - size.height);
        }
        const raw = align === "start" ? at.left : at.right - size.width;
        next = { top, left: clamp(raw, 8, window.innerWidth - size.width - 8) };
      }
      setPos((cur) => (cur && cur.top === next.top && cur.left === next.left ? cur : next));
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  });

  const style: CSSProperties = !pos
    ? { visibility: "hidden" }
    : host
      ? { position: "absolute", top: pos.top, left: pos.left }
      : { top: pos.top, left: pos.left };
  return { container: host ?? document.body, style };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, Math.max(min, max)));
}

/**
 * el の、host の左上からの位置と大きさ（レイアウト上の px。CSS の変形・3D の投影の影響を受けない）。
 * 途中のスクロールの分を引く。host の中になければ null。
 */
export function layoutRect(
  el: HTMLElement,
  host: HTMLElement,
): { left: number; top: number; width: number; height: number } | null {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== host) {
    left += node.offsetLeft;
    top += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    for (let a: HTMLElement | null = node.parentElement; a && a !== parent; a = a.parentElement) {
      left -= a.scrollLeft;
      top -= a.scrollTop;
    }
    if (parent && parent !== host) {
      left -= parent.scrollLeft;
      top -= parent.scrollTop;
    }
    node = parent;
  }
  if (node !== host) return null;
  return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}
