import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import type { SessionEngine } from "../session/SessionEngine";
import { useWorkspace } from "../workspace/store";
import { PANEL_METERS_PER_PX, type PanelTransform } from "./PanelSpace";
import styles from "./Panels.module.css";

export interface PanelPlacement {
  /** 左端からの位置（px）。right を指定した場合は無視する */
  x?: number;
  /** 右端からの位置（px） */
  right?: number;
  y: number;
  width: number;
  /**
   * 高さ（px）。指定すると、中身の量では変わらない。
   * 省略したパネルは、中身に合わせて高さが変わる（画面からはみ出さない上限まで）。
   */
  height?: number;
}

/** これより小さくはできない。タイトルと、中身が少し残る大きさ。 */
let front = 10;
const MIN_PANEL_WIDTH = 280;
const MIN_PANEL_HEIGHT = 160;
/** ドラッグで際限なく大きくならないようにする上限 */
const MAX_PANEL_WIDTH = 2000;
const MAX_PANEL_HEIGHT = 1600;

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
  /** 開き直したとき、画面内に呼び戻す */
  recallKey?: number;
  /** ウィンドウ全体のキー入力を空間操作へ流さない */
  containKeys?: boolean;
  hidden?: boolean;
  onActivate?: () => void;
}

interface PanelState {
  /** true：画面に固定（2D 表示）、false：空間に置く（3D 表示） */
  pinned: boolean;
  x: number;
  y: number;
  width: number;
  /** null の間は中身の高さ。一度大きさを変えたら、その高さで固定する */
  height: number | null;
  transform: PanelTransform | null;
}

/** 左のナビゲーションと上のセッションバーを避ける、画面の作業領域。 */
export function panelViewportInsets() {
  if (typeof window === "undefined") return { left: 16, top: 80 };
  const vars = getComputedStyle(document.documentElement);
  return {
    left: Number.parseFloat(vars.getPropertyValue("--app-content-left")) || 16,
    top: Number.parseFloat(vars.getPropertyValue("--app-panel-top")) || 80,
  };
}

const initialState = (spec: PanelSpec): PanelState => {
  const { x, right, y, width, height } = spec.initial;
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const insets = panelViewportInsets();
  const availableWidth = Math.min(width, Math.max(MIN_PANEL_WIDTH, vw - insets.left - 8));
  const left = Math.max(
    insets.left,
    Math.min(
      right !== undefined ? vw - right - availableWidth : (x ?? insets.left),
      vw - MIN_PANEL_WIDTH - 8,
    ),
  );
  const fittedWidth = Math.min(availableWidth, Math.max(MIN_PANEL_WIDTH, vw - left - 8));
  const top = Math.max(y, insets.top);
  return {
    pinned: true,
    x: left,
    y: top,
    width: fittedWidth,
    height: height == null ? null : fitOnScreen(fittedWidth, height, left, top, true).height,
    transform: null,
  };
};

/** 最小・最大のなかに収める。画面に固定しているときは、右下が画面の中に残るようにする */
function fitOnScreen(
  width: number,
  height: number,
  x: number,
  y: number,
  pinned: boolean,
): { width: number; height: number } {
  let maxW = MAX_PANEL_WIDTH;
  let maxH = MAX_PANEL_HEIGHT;
  if (pinned && typeof window !== "undefined") {
    maxW = Math.min(maxW, Math.max(MIN_PANEL_WIDTH, window.innerWidth - x - 8));
    maxH = Math.min(maxH, Math.max(MIN_PANEL_HEIGHT, window.innerHeight - y - 8));
  }
  return {
    width: Math.round(Math.min(maxW, Math.max(MIN_PANEL_WIDTH, width))),
    height: Math.round(Math.min(maxH, Math.max(MIN_PANEL_HEIGHT, height))),
  };
}

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
  engine?: SessionEngine | null;
  panels: PanelSpec[];
  hidden?: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const specs = useRef(panels);
  specs.current = panels;
  const [states, setStates] = useState<Record<string, PanelState>>({});

  const elementFor = (id: string): HTMLDivElement => {
    let el = elements.current.get(id);
    if (!el) {
      const created = document.createElement("div");
      created.className = styles.host ?? "";
      // 触ったパネルを最前面に出す
      created.addEventListener("pointerdown", () => {
        created.style.zIndex = String(++front);
        specs.current.find((p) => p.id === id)?.onActivate?.();
      });
      created.addEventListener("focusin", () => {
        created.style.zIndex = String(++front);
        specs.current.find((p) => p.id === id)?.onActivate?.();
      });
      created.style.zIndex = String(++front);
      elements.current.set(id, created);
      el = created;
    }
    return el;
  };

  const stateOf = (spec: PanelSpec): PanelState => states[spec.id] ?? initialState(spec);
  const recallKeys = useRef(new Map<string, number>());
  const focusKeys = useRef(new Map<string, PanelSpec["focusKey"]>());

  // 状態に合わせて要素を 2D の層か空間に置く
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ids = new Set(panels.map((p) => p.id));
    // 閉じたパネルを片付ける
    for (const [id, el] of elements.current) {
      if (ids.has(id)) continue;
      engine?.panels.remove(id);
      el.remove();
      elements.current.delete(id);
    }
    for (const p of panels) {
      const st = stateOf(p);
      const el = elementFor(p.id);
      if (p.focusKey !== undefined && focusKeys.current.get(p.id) !== p.focusKey) {
        focusKeys.current.set(p.id, p.focusKey);
        el.style.zIndex = String(++front);
      }
      el.style.width = `${st.width}px`;
      el.style.height = st.height == null ? "" : `${st.height}px`;
      const concealed = hidden || p.hidden;
      el.style.display = concealed ? "none" : "";
      if (concealed || !engine || st.pinned || !st.transform) {
        engine?.panels.remove(p.id);
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
    const unsubscribe = engine?.panels.subscribeMoved((id, transform) =>
      setStates((prev) => {
        const st = prev[id];
        return st ? { ...prev, [id]: { ...st, transform } } : prev;
      }),
    );
    return () => {
      unsubscribe?.();
      for (const id of elements.current.keys()) engine?.panels.remove(id);
    };
  }, [engine]);

  useLayoutEffect(() => {
    const recalled = panels.filter(
      (p) => p.recallKey !== undefined && recallKeys.current.get(p.id) !== p.recallKey,
    );
    if (!recalled.length) return;
    for (const p of recalled) recallKeys.current.set(p.id, p.recallKey as number);
    setStates((prev) => {
      const next = { ...prev };
      for (const p of recalled) {
        const st = prev[p.id] ?? initialState(p);
        const insets = panelViewportInsets();
        const x = Math.max(insets.left, Math.min(st.x, window.innerWidth - MIN_PANEL_WIDTH - 8));
        const y = Math.max(insets.top, Math.min(st.y, window.innerHeight - MIN_PANEL_HEIGHT - 8));
        const actualHeight = elements.current.get(p.id)?.getBoundingClientRect().height || 560;
        const size = fitOnScreen(st.width, st.height ?? actualHeight, x, y, true);
        next[p.id] = {
          ...st,
          ...size,
          height: st.height == null ? null : size.height,
          x,
          y,
          pinned: true,
        };
      }
      return next;
    });
  }, [panels]);

  // Resources から開いたコードと詳細は、そのパネルと同じ置き方（2D か 3D）で出す
  const editorPlace = useWorkspace((s) => s.editorPlace);
  const detailPlace = useWorkspace((s) => s.detailPlace);
  useLayoutEffect(() => {
    if (!engine) return;
    const jobs: {
      id: string;
      mode: "2d" | "3d";
      beside?: string;
      key: "editorPlace" | "detailPlace";
    }[] = [];
    if (editorPlace) jobs.push({ id: "ws-editor", mode: editorPlace.mode, key: "editorPlace" });
    if (detailPlace)
      jobs.push({
        id: "ws-detail",
        mode: detailPlace.mode,
        beside: detailPlace.beside,
        key: "detailPlace",
      });
    const ready = jobs.filter((job) => panels.some((p) => p.id === job.id));
    if (ready.length === 0) return;
    setStates((prev) => {
      let next = prev;
      for (const job of ready) {
        const spec = panels.find((p) => p.id === job.id);
        const beside = panels.find((p) => p.id === job.beside);
        if (spec) next = placeLike(next, spec, job.mode, engine, elements.current, beside);
      }
      return next;
    });
    const clear: { editorPlace?: null; detailPlace?: null } = {};
    for (const job of ready) clear[job.key] = null;
    useWorkspace.setState(clear);
  }, [editorPlace, detailPlace, panels, engine]);

  const togglePin = useCallback(
    (spec: PanelSpec) => {
      if (!engine) return;
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

  const moveBy = useCallback((spec: PanelSpec, dx: number, dy: number) => {
    setStates((prev) => {
      const st = prev[spec.id] ?? initialState(spec);
      // 再描画前に複数回届いても、直前の更新結果に移動量を足す。
      return { ...prev, [spec.id]: { ...st, x: st.x + dx, y: Math.max(0, st.y + dy) } };
    });
  }, []);

  const resizeTo = useCallback((spec: PanelSpec, width: number, height: number) => {
    setStates((prev) => {
      const st = prev[spec.id] ?? initialState(spec);
      const next = fitOnScreen(width, height, st.x, st.y, st.pinned);
      return { ...prev, [spec.id]: { ...st, width: next.width, height: next.height } };
    });
  }, []);

  const placed = engine ? panels.filter((p) => !p.hidden && !stateOf(p).pinned) : [];

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
            containKeys={p.containKeys}
            pinned={!engine || st.pinned}
            fixedHeight={st.height != null}
            maxHeight={st.pinned ? `calc(100vh - ${st.y + 16}px)` : "620px"}
            actions={p.actions}
            onClose={p.onClose}
            onTogglePin={engine ? () => togglePin(p) : undefined}
            onDrag={(dx, dy) => moveBy(p, dx, dy)}
            onResize={(width, height) => resizeTo(p, width, height)}
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

/** 開いた元と同じ置き方にする。すでにその置き方なら、動かさない */
function placeLike(
  prev: Record<string, PanelState>,
  spec: PanelSpec,
  mode: "2d" | "3d",
  engine: SessionEngine,
  elements: Map<string, HTMLElement>,
  beside?: PanelSpec,
): Record<string, PanelState> {
  const st = prev[spec.id] ?? initialState(spec);
  if (mode === "2d") {
    const source = beside ? (prev[beside.id] ?? initialState(beside)) : undefined;
    if (beside && source?.pinned) return placeBeside(prev, spec.id, st, beside.id, source);
    return st.pinned ? prev : { ...prev, [spec.id]: { ...st, pinned: true } };
  }
  if (!st.pinned && st.transform) return prev;
  const rect = elements.get(spec.id)?.getBoundingClientRect();
  const others = Object.values(prev).filter((p) => p !== st && !p.pinned).length;
  return {
    ...prev,
    [spec.id]: { ...st, pinned: false, transform: placeInFront(engine, rect, others) },
  };
}

/**
 * 画面に固定したパネル（source）の右側に並べる。
 * 右に入りきらないときは、元のパネルを左へ寄せて場所を空ける（寄せきれない分は重ねる）。
 */
function placeBeside(
  prev: Record<string, PanelState>,
  id: string,
  st: PanelState,
  sourceId: string,
  source: PanelState,
): Record<string, PanelState> {
  const insets = panelViewportInsets();
  const gap = 8;
  const limit = window.innerWidth - gap;
  const sourceX = Math.max(insets.left, Math.min(source.x, limit - st.width - gap - source.width));
  const x = Math.max(insets.left, Math.min(sourceX + source.width + gap, limit - st.width));
  return {
    ...prev,
    [sourceId]: { ...source, x: sourceX },
    [id]: { ...st, x, y: Math.max(insets.top, source.y), pinned: true },
  };
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
  containKeys?: boolean;
  pinned: boolean;
  /** 高さを指定済み（中身では変えない） */
  fixedHeight: boolean;
  maxHeight: string;
  actions?: ReactNode;
  onClose?: () => void;
  onTogglePin?: () => void;
  onDrag: (dx: number, dy: number) => void;
  onResize: (width: number, height: number) => void;
  children: ReactNode;
}) {
  const drag = useRef<{ x: number; y: number } | null>(null);
  const resize = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
    sx: number;
    sy: number;
  } | null>(null);

  return (
    <section
      className={`glass ${styles.window}`}
      aria-label={props.title}
      role={props.containKeys ? "dialog" : undefined}
      tabIndex={props.containKeys ? -1 : undefined}
      onKeyDown={props.containKeys ? (event) => event.stopPropagation() : undefined}
      onKeyUp={props.containKeys ? (event) => event.stopPropagation() : undefined}
      data-fixed={props.fixedHeight || undefined}
      style={{ maxHeight: props.fixedHeight ? undefined : props.maxHeight }}
    >
      <header
        className={styles.titlebar}
        onPointerDown={(e) => {
          if (e.button !== 0 || !props.pinned || (e.target as HTMLElement).closest("button"))
            return;
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
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <h2 className={styles.title}>{props.title}</h2>
        {props.actions}
        {props.onTogglePin && (
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
        )}
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
      <button
        type="button"
        className={styles.resize}
        aria-label="大きさを変える"
        title="ドラッグして大きさを変える"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const host = e.currentTarget.parentElement?.parentElement;
          if (!host || host.offsetWidth === 0 || host.offsetHeight === 0) return;
          e.preventDefault();
          const rect = host.getBoundingClientRect();
          resize.current = {
            x: e.clientX,
            y: e.clientY,
            w: host.offsetWidth,
            h: host.offsetHeight,
            sx: rect.width / host.offsetWidth || 1,
            sy: rect.height / host.offsetHeight || 1,
          };
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // 照準から渡した合成イベントでは、ポインターを捕まえられない
          }
        }}
        onPointerMove={(e) => {
          const d = resize.current;
          if (!d) return;
          props.onResize(d.w + (e.clientX - d.x) / d.sx, d.h + (e.clientY - d.y) / d.sy);
        }}
        onPointerUp={() => {
          resize.current = null;
        }}
        onPointerCancel={() => {
          resize.current = null;
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 48 : 16;
          const delta: [number, number] | null =
            e.key === "ArrowRight"
              ? [step, 0]
              : e.key === "ArrowLeft"
                ? [-step, 0]
                : e.key === "ArrowDown"
                  ? [0, step]
                  : e.key === "ArrowUp"
                    ? [0, -step]
                    : null;
          if (!delta) return;
          const host = e.currentTarget.parentElement?.parentElement;
          if (!host) return;
          e.preventDefault();
          const [dx, dy] = delta;
          props.onResize(host.offsetWidth + dx, host.offsetHeight + dy);
        }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M6 14h8V6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10 14h4v-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
    </section>
  );
}
