import { create } from "zustand";

/**
 * 2D のパネル（画面に固定したパネル）が乗っている、1 枚のキャンバスの見え方（ADR 0081）。
 * パネルの位置はキャンバスの上の座標で持ち、画面の位置は「位置 × scale + ずらし量」になる。
 * どのパネルの層（メインメニュー・ワークスペース）も、この 1 つの見え方を共有する。
 */
export interface CanvasView {
  /** キャンバスの原点が見えている画面の位置（px） */
  x: number;
  y: number;
  /** 拡大率。1 で等倍 */
  scale: number;
}

export const MIN_CANVAS_SCALE = 0.25;
export const MAX_CANVAS_SCALE = 2;
const IDENTITY: CanvasView = { x: 0, y: 0, scale: 1 };

export const usePanelCanvas = create<CanvasView & { reset: () => void }>((set) => ({
  ...IDENTITY,
  reset: () => set(IDENTITY),
}));

export function canvasView(): CanvasView {
  const { x, y, scale } = usePanelCanvas.getState();
  return { x, y, scale };
}

export function isIdentityView(v: CanvasView): boolean {
  return v.x === 0 && v.y === 0 && v.scale === 1;
}

/** 画面の位置 → キャンバスの位置 */
export function toCanvas(v: CanvasView, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale };
}

/** キャンバスの位置 → 画面の位置 */
export function toScreen(v: CanvasView, cx: number, cy: number): { x: number; y: number } {
  return { x: cx * v.scale + v.x, y: cy * v.scale + v.y };
}

/** 画面の (sx, sy) を動かさずに、拡大率を変える */
export function zoomAt(v: CanvasView, sx: number, sy: number, scale: number): CanvasView {
  const next = Math.min(MAX_CANVAS_SCALE, Math.max(MIN_CANVAS_SCALE, scale));
  const k = next / v.scale;
  return { x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k, scale: next };
}

/**
 * 左上を原点にして拡大・縮小する CSS の変形。left/top にはキャンバスの位置を入れたままにし、
 * その差分だけを変形で動かす。
 */
export function hostTransform(v: CanvasView, cx: number, cy: number): string {
  if (isIdentityView(v)) return "";
  const s = v.scale;
  return `translate(${v.x + cx * (s - 1)}px, ${v.y + cy * (s - 1)}px) scale(${s})`;
}

/** 見えている 2D のパネルがあるか。無いときは、ホイールやクリックをブラウザに任せる */
function hasVisibleFlatPanel(): boolean {
  for (const el of document.querySelectorAll<HTMLElement>('[data-panel-id][data-mode="2d"]')) {
    if (el.style.display !== "none" && el.isConnected) return true;
  }
  return false;
}

/** ホイールの量を px にそろえる */
function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * 16;
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * 400;
  return e.deltaY;
}

let installed = 0;
let uninstall: (() => void) | null = null;

/**
 * ホイールを押し込んでドラッグするとキャンバスごと動かし、Ctrl＋ホイールで拡大・縮小する。
 * 空間に入っている間（ポインターロック中）は、空間の操作を優先して何もしない。
 * パネルの層がいくつあっても、操作は 1 つだけ付ける。戻り値で外す。
 */
export function installCanvasControls(): () => void {
  installed++;
  if (installed === 1) uninstall = attach();
  return () => {
    installed--;
    if (installed === 0) {
      uninstall?.();
      uninstall = null;
    }
  };
}

function attach(): () => void {
  let pan: { x: number; y: number; moved: boolean } | null = null;
  let suppressAux = false;

  const onDown = (e: MouseEvent) => {
    if (e.button !== 1 || document.pointerLockElement || !hasVisibleFlatPanel()) return;
    // 自動スクロール（ホイールクリックで出る矢印）を出さない
    e.preventDefault();
    pan = { x: e.clientX, y: e.clientY, moved: false };
    document.documentElement.dataset.canvasPanning = "";
  };
  const onMove = (e: MouseEvent) => {
    if (!pan) return;
    if ((e.buttons & 4) === 0) {
      end();
      return;
    }
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (dx === 0 && dy === 0) return;
    pan.x = e.clientX;
    pan.y = e.clientY;
    pan.moved = true;
    const v = usePanelCanvas.getState();
    usePanelCanvas.setState({ x: v.x + dx, y: v.y + dy });
    e.preventDefault();
  };
  const end = () => {
    if (pan?.moved) suppressAux = true;
    pan = null;
    delete document.documentElement.dataset.canvasPanning;
  };
  const onUp = (e: MouseEvent) => {
    if (e.button === 1 && pan) end();
  };
  // 動かしたあとは、ホイールクリック（リンクを新しいタブで開く・貼り付け）として扱わない
  const onAux = (e: MouseEvent) => {
    if (e.button !== 1 || !suppressAux) return;
    suppressAux = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey || document.pointerLockElement) return;
    // 右ボタンで 3D のパネルを持っている間は、空間の側がホイールを使う
    if (e.buttons & 2) return;
    if (!hasVisibleFlatPanel()) return;
    // ブラウザの拡大・縮小を止める（タッチパッドのピンチも ctrlKey 付きのホイールで届く）
    e.preventDefault();
    e.stopPropagation();
    const dy = Math.max(-200, Math.min(200, wheelPixels(e)));
    if (dy === 0) return;
    const v = usePanelCanvas.getState();
    usePanelCanvas.setState(zoomAt(v, e.clientX, e.clientY, v.scale * Math.exp(-dy * 0.0025)));
  };

  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("auxclick", onAux, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("blur", end);
  return () => {
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("auxclick", onAux, true);
    window.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("blur", end);
    end();
  };
}
