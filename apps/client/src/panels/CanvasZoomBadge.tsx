import styles from "./Panels.module.css";
import { isIdentityView, usePanelCanvas } from "./panelCanvas";

/**
 * キャンバスを動かした・拡大縮小したときだけ、右下に倍率と「元に戻す」を出す（ADR 0081）。
 * パネルを見失ったときの逃げ道。
 */
export function CanvasZoomBadge() {
  const view = usePanelCanvas();
  if (isIdentityView(view)) return null;
  return (
    <div className={`glass ${styles.zoomBadge}`} role="status" aria-label="ウィンドウの表示">
      <span className={styles.zoomValue}>{Math.round(view.scale * 100)}%</span>
      <button
        type="button"
        className={styles.trayBtn}
        title="ウィンドウの位置と大きさの表示を元に戻す"
        onClick={view.reset}
      >
        元に戻す
      </button>
    </div>
  );
}
