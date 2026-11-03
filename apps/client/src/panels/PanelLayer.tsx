import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import type { SessionEngine } from "../session/SessionEngine";
import { PANEL_METERS_PER_PX, type PanelTransform } from "./PanelSpace";
import styles from "./Panels.module.css";

export interface PanelPlacement {
  /** 左端からの位置（px）。right を指定した場合は無視する */
  x?: number;
  /** 右端からの位置（px） */
  right?: number;
  y: number;
  width: number;
}

export interface PanelSpec {
  id: string;
  title: string;
  render: () => ReactNode;
  initial: PanelPlacement;
  /** タイトルバーに並べる操作 */
  actions?: ReactNode;
  /** この値が変わったらパネルを最前面に出す（コードを開いたときのエディタなど） */
  focusKey?: string | number | null;
  onClose?: () => void;
}

interface PanelState {
  /** true：画面に固定（2D 表示）、false：空間に置く（3D 表示） */
  pinned: boolean;
  x: number;
  y: number;
  transform: PanelTransform | null;
}

const initialState = (spec: PanelSpec): PanelState => {
  const { x, right, y, width } = spec.initial;
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const left = right !== undefined ? vw - right - width : (x ?? 16);
  return { pinned: true, x: Math.max(8, left), y, transform: null };
};

/**
 * パネルを 2D（画面に固定）と 3D（空間に置く）で切り替えて表示する。
 * 中身は React のポータルで 1 つの DOM 要素に描き、その要素を 2D の層と空間の間で移すので、
 * 切り替えても入力中の内容やスクロール位置が保たれる。
 */
export function PanelLayer({
  engine,
  panels,
  hidden = false,
}: {
  engine: SessionEngine;
  panels: PanelSpec[];
  hidden?: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const [states, setStates] = useState<Record<string, PanelState>>({});

  const front = useRef(1);
  const elementFor = (id: string): HTMLDivElement => {
    let el = elements.current.get(id);
    if (!el) {
      const created = document.createElement("div");
      created.className = styles.host ?? "";
      // 触ったパネルを最前面に出す
      created.addEventListener("pointerdown", () => {
        created.style.zIndex = String(++front.current);
      });
      created.style.zIndex = String(++front.current);
      elements.current.set(id, created);
      el = created;
    }
    return el;
  };

  const stateOf = (spec: PanelSpec): PanelState => states[spec.id] ?? initialState(spec);
  const focusKeys = useRef(new Map<string, PanelSpec["focusKey"]>());

  // 状態に合わせて要素を 2D の層か空間に置く
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ids = new Set(panels.map((p) => p.id));
    // 閉じたパネルを片付ける
    for (const [id, el] of elements.current) {
      if (ids.has(id)) continue;
      engine.panels.remove(id);
      el.remove();
      elements.current.delete(id);
    }
    for (const p of panels) {
      const st = stateOf(p);
      const el = elementFor(p.id);
      if (p.focusKey !== undefined && focusKeys.current.get(p.id) !== p.focusKey) {
        focusKeys.current.set(p.id, p.focusKey);
        el.style.zIndex = String(++front.current);
      }
      el.style.width = `${p.initial.width}px`;
      el.style.display = hidden ? "none" : "";
      if (st.pinned || !st.transform) {
        engine.panels.remove(p.id);
        if (el.parentElement !== overlay) overlay.appendChild(el);
        el.style.left = `${st.x}px`;
        el.style.top = `${st.y}px`;
        el.dataset.mode = "2d";
      } else {
        el.style.left = "";
        el.style.top = "";
        el.dataset.mode = "3d";
        engine.panels.place(p.id, el, st.transform);
      }
    }
  });

  useLayoutEffect(() => {
    // 右ドラッグで動かした置き場所を覚える（覚えないと、次の描画で元の場所に戻る）
    engine.panels.onMoved = (id, transform) =>
      setStates((prev) => {
        const st = prev[id];
        return st ? { ...prev, [id]: { ...st, transform } } : prev;
      });
    return () => {
      engine.panels.onMoved = null;
      for (const id of elements.current.keys()) engine.panels.remove(id);
    };
  }, [engine]);

  const togglePin = useCallback(
    (spec: PanelSpec) => {
      const id = spec.id;
      // 画面上でいまパネルがある位置の先に置く（どのパネルも正面の同じ場所に重なると、
      // 後ろのパネルがクリックを受け取れなくなるため）
      const rect = elements.current.get(id)?.getBoundingClientRect();
      setStates((prev) => {
        const st = prev[id] ?? initialState(spec);
        if (st.pinned) {
          const others = Object.values(prev).filter((p) => !p.pinned).length;
          return {
            ...prev,
            [id]: { ...st, pinned: false, transform: placeInFront(engine, rect, others) },
          };
        }
        return { ...prev, [id]: { ...st, pinned: true } };
      });
    },
    [engine],
  );

  /** 空間に置いたパネルをすべて画面に戻す（3D のパネルが操作しづらいときの逃げ道） */
  const pinAll = useCallback(() => {
    setStates((prev) => {
      const next: Record<string, PanelState> = {};
      for (const [id, st] of Object.entries(prev)) next[id] = { ...st, pinned: true };
      return next;
    });
  }, []);

  const moveTo = useCallback((spec: PanelSpec, x: number, y: number) => {
    setStates((prev) => {
      const st = prev[spec.id] ?? initialState(spec);
      return { ...prev, [spec.id]: { ...st, x, y: Math.max(0, y) } };
    });
  }, []);

  const placed = panels.filter((p) => !stateOf(p).pinned);

  return (
    <div ref={overlayRef} className={styles.overlay}>
      {placed.length > 0 && !hidden && (
        <div className={`glass ${styles.tray}`} role="toolbar" aria-label="空間に置いたパネル">
          <span className={styles.trayLabel}>空間のパネル</span>
          {placed.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.trayBtn}
              title={`${p.title} を画面に戻す`}
              onClick={() => togglePin(p)}
            >
              {p.title}
            </button>
          ))}
          <button type="button" className={styles.trayBtn} onClick={pinAll}>
            すべて画面に戻す
          </button>
        </div>
      )}
      {panels.map((p) => {
        const st = stateOf(p);
        return createPortal(
          <PanelWindow
            title={p.title}
            pinned={st.pinned}
            maxHeight={st.pinned ? `calc(100vh - ${st.y + 16}px)` : "620px"}
            actions={p.actions}
            onClose={p.onClose}
            onTogglePin={() => togglePin(p)}
            onDrag={(dx, dy) => moveTo(p, st.x + dx, st.y + dy)}
          >
            {p.render()}
          </PanelWindow>,
          elementFor(p.id),
          p.id,
        );
      })}
    </div>
  );
}

/**
 * 画面上でパネルがいまある矩形と、ほぼ同じ位置・大きさに見える所へ、こちらを向けて置く。
 * 奥行きは「1px = PANEL_METERS_PER_PX」の大きさで見える距離にする。
 * 重ねて置いても同じ面に並ばないよう、置いてある枚数だけ少し手前にずらす。
 */
function placeInFront(
  engine: SessionEngine,
  rect: DOMRect | undefined,
  others: number,
): PanelTransform {
  const cam = engine.camera;
  cam.updateMatrixWorld();
  const canvas = engine.renderer.domElement.getBoundingClientRect();
  const fov = THREE.MathUtils.degToRad(cam.fov);
  const depth =
    THREE.MathUtils.clamp(
      (canvas.height * PANEL_METERS_PER_PX) / (2 * Math.tan(fov / 2)),
      1.2,
      2.5,
    ) -
    others * 0.03;
  const ndc = rect
    ? new THREE.Vector2(
        ((rect.left + rect.width / 2 - canvas.left) / canvas.width) * 2 - 1,
        -(((rect.top + rect.height / 2 - canvas.top) / canvas.height) * 2 - 1),
      )
    : new THREE.Vector2(0, 0);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, cam);
  const forward = cam.getWorldDirection(new THREE.Vector3());
  // 光線の長さではなく、カメラの向きに沿った奥行きで揃える（端のパネルが近づきすぎないように）
  const t = depth / Math.max(ray.ray.direction.dot(forward), 0.2);
  const p = ray.ray.at(t, new THREE.Vector3());
  return { position: [p.x, p.y, p.z], yaw: engine.pose().yaw };
}

function PanelWindow(props: {
  title: string;
  pinned: boolean;
  maxHeight: string;
  actions?: ReactNode;
  onClose?: () => void;
  onTogglePin: () => void;
  onDrag: (dx: number, dy: number) => void;
  children: ReactNode;
}) {
  const drag = useRef<{ x: number; y: number } | null>(null);

  return (
    <section
      className={`glass ${styles.window}`}
      aria-label={props.title}
      style={{ maxHeight: props.maxHeight }}
    >
      <header
        className={styles.titlebar}
        onPointerDown={(e) => {
          if (!props.pinned || (e.target as HTMLElement).closest("button")) return;
          drag.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          props.onDrag(e.clientX - drag.current.x, e.clientY - drag.current.y);
          drag.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <h2 className={styles.title}>{props.title}</h2>
        {props.actions}
        <button
          type="button"
          className={styles.pin}
          aria-pressed={props.pinned}
          aria-label={
            props.pinned ? "ピン留め: オン（画面に固定）" : "ピン留め: オフ（3D空間に置く）"
          }
          title={props.pinned ? "ピン留め: オン（画面に固定）" : "ピン留め: オフ（3D空間に置く）"}
          onClick={props.onTogglePin}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8"
              fill={props.pinned ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {props.onClose && (
          <button
            type="button"
            className={styles.pin}
            aria-label={`${props.title} を閉じる`}
            title="閉じる"
            onClick={props.onClose}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
        )}
      </header>
      <div className={styles.body}>{props.children}</div>
    </section>
  );
}
