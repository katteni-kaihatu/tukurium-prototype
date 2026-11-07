import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./RingMenu.module.css";
import { type RingItem, ringItems } from "./ringMenu";
import type { SessionEngine } from "./SessionEngine";

/** マウスをこれだけ動かしたら、その向きの項目を選ぶ（px） */
const PICK_PX = 24;

/**
 * T で開くリングメニュー（ADR 0053）。空間に入っている（照準）ときは、マウスを動かした向きの項目を選び、
 * 左クリックで決める。右クリック・T・Esc で閉じる。マウスを解放しているときは、項目を直接押す。
 */
export function RingMenu({ engine }: { engine: SessionEngine }) {
  const [items, setItems] = useState<RingItem[] | null>(null);
  const [selected, setSelectedState] = useState(-1);
  const selectedRef = useRef(-1);
  const setSelected = useCallback((i: number) => {
    selectedRef.current = i;
    setSelectedState(i);
  }, []);
  const aim = useRef({ x: 0, y: 0 });
  const open = items !== null;

  const close = useCallback(() => {
    setItems(null);
    setSelected(-1);
  }, [setSelected]);

  const choose = useCallback(
    (index: number) => {
      const item = items?.[index];
      if (item?.enabled) item.run();
      close();
    },
    [items, close],
  );

  // T で開け閉めする（文字を入力しているときは除く）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.repeat) return;
      if (e.code === "KeyT") {
        e.preventDefault();
        if (open) close();
        else {
          aim.current = { x: 0, y: 0 };
          setSelected(-1);
          setItems(ringItems());
        }
      } else if (e.code === "Escape" && open) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, setSelected]);

  // 開いている間は見回さず、マウスの動きで項目を選ぶ。左クリックで決め、右クリックで閉じる
  useEffect(() => {
    if (!items) return;
    const count = items.length;
    engine.controller.setLookOverride((dx, dy) => {
      const next = { x: aim.current.x + dx, y: aim.current.y + dy };
      const len = Math.hypot(next.x, next.y);
      // 遠くまで動かしても、向きだけを覚える
      aim.current =
        len > PICK_PX * 3
          ? { x: (next.x / len) * PICK_PX * 3, y: (next.y / len) * PICK_PX * 3 }
          : next;
      if (count === 0 || len < PICK_PX) return;
      setSelected(sectorOf(aim.current.x, aim.current.y, count));
    });
    const release = engine.claimPointer({
      down: (button) => {
        if (button === 0) {
          choose(selectedRef.current);
          return true;
        }
        if (button === 2) {
          close();
          return true;
        }
        return false;
      },
      up: () => {},
    });
    return () => {
      engine.controller.setLookOverride(null);
      release();
    };
  }, [items, engine, choose, close, setSelected]);

  if (!items) return null;
  return (
    <div className={styles.ring} role="menu" aria-label="リングメニュー">
      <div className={styles.center}>
        <span>T で閉じる</span>
      </div>
      {items.length === 0 ? (
        <p className={styles.empty}>いまできることはありません</p>
      ) : (
        items.map((item, i) => {
          const angle = angleOf(i, items.length);
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={styles.item}
              data-selected={i === selected || undefined}
              disabled={!item.enabled}
              title={item.hint}
              style={{
                left: `calc(50% + ${Math.sin(angle) * 92}px)`,
                top: `calc(50% - ${Math.cos(angle) * 92}px)`,
              }}
              onMouseEnter={() => setSelected(i)}
              onClick={() => choose(i)}
            >
              <span className={styles.label}>{item.label}</span>
              {!item.enabled && item.hint && <small>{item.hint}</small>}
            </button>
          );
        })
      )}
    </div>
  );
}

/** i 番目の項目の向き（ラジアン。0 が上、時計回り） */
function angleOf(i: number, count: number): number {
  return (i / count) * Math.PI * 2;
}

/** マウスを動かした向き（画面の下が +y）に、いちばん近い項目 */
function sectorOf(x: number, y: number, count: number): number {
  const angle = (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2);
  return Math.round(angle / ((Math.PI * 2) / count)) % count;
}
