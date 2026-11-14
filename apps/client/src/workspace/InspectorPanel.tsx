import type { EntityId, FieldValue, KokoStateValues } from "@tukurium/eks";
import {
  BUILTIN,
  type EntityDef,
  isBuiltin,
  isInstanceRoot,
  type KeepMark,
  type MeshShape,
} from "@tukurium/repo-model";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePanelPopover } from "../panels/popover";
import { ChangeMark, MarkedLine } from "./ChangeMark";
import {
  type ChangeKind,
  type DropMode,
  dropPlacement,
  entityChange,
  outputChange,
  prefabChange,
  savedKeep,
  savedPrefabKeep,
  selfAndDescendants,
  treeMark,
} from "./changeMarks";
import { DefinitionProperties } from "./DefinitionProperties";
import { FieldInput } from "./FieldInput";
import { fitLabelElement } from "./fitLabel";
import { useCanEdit, useEditTarget, useProject } from "./hooks";
import styles from "./InspectorPanel.module.css";
import {
  clampDetailsWidth,
  DETAILS_DEFAULT,
  detailsWidthBounds,
  fieldLabelWidth,
  readDetailsWidth,
  storeDetailsWidth,
} from "./inspectorLayout";
import { KokoRoleIcon } from "./KokoRoleIcon";
import { LibraryContents } from "./LibraryContents";
import { MakePrefabIcon, PrefabFromEntityAsk } from "./PrefabFromEntityAsk";
import { BadgeDot, badgeFor } from "./ProblemBadge";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { packageAliasOf, useProblemSummary, useSystemQuery } from "./useProblems";
import { useSavedFiles } from "./useSavedFiles";

/** Built-in の物理を、付ける人に短く伝える（ADR 0068） */
const KOKO_HINT: Record<string, string> = {
  [BUILTIN.Collider]:
    "プレイヤーと、RigidBody の付いた物がぶつかる形です。形が「見た目に合わせる」のときと、大きさが 0 のときは、Mesh の形と大きさを使います。sensor にすると押し返しません。",
  [BUILTIN.RigidBody]:
    "付けると重力で動きます。ぶつかるには Collider も要ります。高さ 0 の地面でも止まります。gravityScale を 0 にすると落ちません。lockMove / lockRotate をオンにした軸には動かず、回りません（横から見た 2D なら lockMoveZ・lockRotateX・lockRotateY）。",
};

/**
 * 階層の中に置くと、スクロール枠と右の詳細で切れる。
 * 2D では画面の上に出して、はみ出してもよい。3D に置いたパネルでは、そのパネルの上に出す。
 */
function FloatMenu({
  anchor,
  align,
  className,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  /** start は左端、end は右端をボタンに合わせる */
  align: "start" | "end";
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLUListElement>(null);
  const { container, style } = usePanelPopover(anchor, menuRef, align);
  useLayoutEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchor.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [anchor, onClose]);
  return createPortal(
    <ul
      ref={menuRef}
      className={`${ui.menu} ${ui.menuPop}${className ? ` ${className}` : ""}`}
      style={style}
    >
      {children}
    </ul>,
    container,
  );
}

/**
 * 詳細の固定幅と、欄の名前の幅。境目のドラッグで詳細を変えると、名前の幅も増える。
 * 名前は省略せず、枠に入るまで文字を小さくする。
 */
function useDetailsColumn() {
  const splitRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState(readDetailsWidth);
  const [containerWidth, setContainerWidth] = useState(0);
  const [stacked, setStacked] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches,
  );
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointer: number; startX: number; startW: number; width: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const apply = () => setContainerWidth(el.clientWidth);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const apply = () => setStacked(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // 上下に分かれているときは、詳細がパネルの幅いっぱいになる
  const detailsWidth = clampDetailsWidth(preferred, stacked ? 0 : containerWidth);
  const labelWidth = fieldLabelWidth(stacked ? containerWidth || DETAILS_DEFAULT : detailsWidth);
  const bounds = detailsWidthBounds(stacked ? 0 : containerWidth);

  useLayoutEffect(() => {
    const root = propsRef.current;
    // 名前の幅が変わったフレームでも掛け直す（詳細の外枠の幅は変わらないことがある）
    const labelClass = ui.label;
    if (!root || labelWidth <= 0 || !labelClass) return;
    const selector = `.${CSS.escape(labelClass)}`;
    const fit = () => {
      for (const el of root.querySelectorAll<HTMLElement>(selector)) fitLabelElement(el);
    };
    fit();
    // 高さの変化（文字を縮めたこと）では掛け直さない。幅が変わったときだけ
    let lastWidth = root.clientWidth;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width === lastWidth) return;
      lastWidth = width;
      fit();
    });
    ro.observe(root);
    const mo = new MutationObserver(fit);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    let stop = false;
    void document.fonts?.ready.then(() => {
      if (!stop) fit();
    });
    return () => {
      stop = true;
      ro.disconnect();
      mo.disconnect();
    };
  }, [labelWidth]);

  const onPointerDown = (event: ReactPointerEvent<HTMLHRElement>) => {
    if (event.button !== 0 || stacked) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      startX: event.clientX,
      startW: detailsWidth,
      width: detailsWidth,
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLHRElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointer) return;
    const total = splitRef.current?.clientWidth ?? containerWidth;
    const next = clampDetailsWidth(current.startW + (current.startX - event.clientX), total);
    current.width = next;
    setPreferred(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLHRElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointer) return;
    drag.current = null;
    setDragging(false);
    storeDetailsWidth(current.width);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLHRElement>) => {
    if (stacked) return;
    const total = splitRef.current?.clientWidth ?? containerWidth;
    const step = event.shiftKey ? 40 : 16;
    const { min, max } = detailsWidthBounds(total);
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = detailsWidth + step;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") next = detailsWidth - step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next == null) return;
    event.preventDefault();
    const clamped = clampDetailsWidth(next, total);
    setPreferred(clamped);
    storeDetailsWidth(clamped);
  };

  return {
    splitRef,
    propsRef,
    detailsWidth,
    labelWidth,
    bounds,
    dragging,
    stacked,
    splitter: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
      onKeyDown,
    },
  };
}

/**
 * Inspector：左に Hierarchy（アウトプットか、開いているプレハブの Entity の木）、右に選んだものの Properties。
 * Play 中は実行中の World を読み取り専用で表示する（要件 §7「編集と実行を分ける」）。
 * ライブラリは Entity を持たないので、左は含めるリソースを選ぶ画面にする（ADR 0055）。
 */
export function InspectorPanel() {
  const project = useProject();
  const outputId = useWorkspace((s) => s.outputId);
  const prefabOpen = useWorkspace((s) => s.mode === "edit" && s.editingPrefab !== null);
  useWorkspace((s) => s.rev);
  // プレハブを開いている間は、アウトプットがライブラリでも、プレハブの Hierarchy を出す
  const library = !prefabOpen && project.output(outputId)?.kind === "library";
  const column = useDetailsColumn();
  return (
    <div
      ref={column.splitRef}
      className={styles.split}
      data-dragging={column.dragging || undefined}
      style={{ "--details-w": `${column.detailsWidth}px` } as CSSProperties}
    >
      {library ? <LibraryContents /> : <Hierarchy />}
      <div
        ref={column.propsRef}
        className={styles.props}
        style={{ "--field-label": `${column.labelWidth}px` } as CSSProperties}
      >
        <Properties />
      </div>
      {!column.stacked && (
        <hr
          className={styles.splitter}
          aria-orientation="vertical"
          aria-label="詳細の幅"
          aria-valuemin={column.bounds.min}
          aria-valuemax={column.bounds.max}
          aria-valuenow={column.detailsWidth}
          aria-valuetext={`${column.detailsWidth}px`}
          tabIndex={0}
          title="ドラッグして詳細の幅を変える"
          data-dragging={column.dragging || undefined}
          {...column.splitter}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hierarchy

const NEW_ENTITIES: { label: string; shape: MeshShape | null; size: [number, number, number] }[] = [
  { label: "空の Entity", shape: null, size: [1, 1, 1] },
  { label: "ボックス", shape: "box", size: [0.5, 0.5, 0.5] },
  { label: "球", shape: "sphere", size: [0.5, 0.5, 0.5] },
  { label: "円柱", shape: "cylinder", size: [0.5, 0.8, 0.5] },
  { label: "カプセル", shape: "capsule", size: [0.4, 1, 0.4] },
  { label: "平面", shape: "plane", size: [2, 1, 2] },
];

interface TreeNode {
  id: EntityId;
  name: string;
  parent: EntityId | null;
  /** プレハブのインスタンスなら、そのプレハブの ID（ADR 0076） */
  instance?: string;
  /** プレハブから来た、インスタンスの中の Entity。いまは、インスタンスでは変えられない */
  fromPrefab?: boolean;
  /** 開いているプレハブの、いちばん上の Entity。消せず、動かせない */
  root?: boolean;
}

/** Resources からプレハブをドラッグしているときの種類（Hierarchy に落とすと、インスタンスを置く） */
const PREFAB_DRAG = "application/x-tukurium-prefab";

function Hierarchy() {
  const { outputId, selection, select, mode, runtime, viewPoint, openPrefab, closePrefab } =
    useWorkspace();
  const project = useProject();
  const canEdit = useCanEdit();
  const saved = useSavedFiles();
  const target = useEditTarget();
  const { hierarchy: problems, resources: resourceProblems } = useProblemSummary();
  useWorkspace((s) => (s.mode === "edit" ? s.rev : s.simRev));
  const [menu, setMenu] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [dropOver, setDropOver] = useState<{ id: string; mode: DropMode } | null>(null);
  const [dupFor, setDupFor] = useState<string | null>(null);
  const [dupAnchor, setDupAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const output = project.output(outputId);
  const editing = canEdit;
  const rt = mode !== "edit" ? runtime() : null;
  // 開いているプレハブ（ADR 0076）。開いている間は、アウトプットの代わりに、プレハブの中の Entity を出す
  const prefab = target.prefabId ? project.prefab(target.prefabId) : undefined;
  /** いま出している木の持ち主（アウトプットか、開いているプレハブ）の ID */
  const ownerId = prefab ? prefab.id : outputId;

  // Edit：プレハブのインスタンスを、中身に展開した並び（ADR 0076）
  const nodes: TreeNode[] = rt
    ? rt.world.entityIds().map((id) => ({ id, name: rt.nameOf(id), parent: rt.world.parentOf(id) }))
    : target.snapshot.entities
        .filter((e) => e.output === ownerId)
        .sort((a, b) => a.order - b.order)
        .map((e) => ({
          id: e.id,
          name: e.name,
          parent: e.parent,
          ...(isInstanceRoot(e) && e.origin ? { instance: e.origin.prefab } : {}),
          fromPrefab: e.origin !== undefined && !isInstanceRoot(e),
          root: e.id === prefab?.root,
        }));
  const fromPrefab = (id: string | null) =>
    id !== null && nodes.some((n) => n.id === id && n.fromPrefab);

  const selectedEntity = selection?.kind === "entity" ? selection.id : null;
  const ownerSelected = prefab
    ? selection?.kind === "prefab" && selection.id === prefab.id
    : selection?.kind === "output" && selection.id === outputId;
  const prefabEntities = prefab && mode === "edit" ? project.prefabEntities(prefab.id) : null;
  const projectEntities = prefabEntities ?? (mode === "edit" ? project.entities(outputId) : []);
  const keepNow = prefab ? prefab.keep : (output?.keep ?? []);
  const keepWas = prefab ? savedPrefabKeep(saved, prefab.id) : savedKeep(saved, outputId);
  const kindOf = new Map<string, ChangeKind | null>();
  for (const e of projectEntities) {
    kindOf.set(e.id, entityChange(saved, e, { saved: keepWas, current: keepNow }).kind);
  }
  const ownerKind =
    prefab && prefabEntities
      ? prefabChange(saved, prefab, prefabEntities)
      : output && mode === "edit"
        ? outputChange(saved, output).kind
        : null;

  const openOf = (id: string) => {
    setClosed((c) => ({ ...c, [id]: false }));
  };

  const add = (spec: (typeof NEW_ENTITIES)[number]) => {
    setMenu(false);
    // 空の Entity には KokoState を付けない。形があるものだけ Transform と Mesh を付ける（ADR 0049）
    const states: Record<string, KokoStateValues> = {};
    if (spec.shape) {
      states[BUILTIN.Transform] = { position: viewPoint?.() ?? [0, 1, 0] };
      states[BUILTIN.Mesh] = { shape: spec.shape, size: spec.size };
    }
    // プレハブの中では、いちばん上の Entity の下に入る（場所は、いちばん上の Entity から見た位置）
    const id = prefab
      ? project.addPrefabEntity({ prefab: prefab.id, name: spec.label, states })
      : project.addEntity({ output: outputId, name: spec.label, states });
    openOf(ownerId);
    if (prefab) openOf(prefab.root);
    select({ kind: "entity", id });
  };

  const duplicate = (entityId: string, withChildren: boolean) => {
    setDupFor(null);
    try {
      setError(null);
      // インスタンスを複製すると、同じプレハブのインスタンスが一つ増える
      const made = project.duplicateEntity(entityId, withChildren);
      if (!made) return;
      openOf(project.findEntity(made)?.parent ?? ownerId);
      select({ kind: "entity", id: made });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = (entityId: string) => {
    const gone = new Set(selfAndDescendants(nodes, entityId));
    try {
      setError(null);
      project.removeEntity(entityId);
      if (selectedEntity && gone.has(selectedEntity)) select(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const askRemove = (entityId: string, name: string) => {
    const nested = selfAndDescendants(nodes, entityId).length - 1;
    const message =
      nested > 0
        ? `${name} を削除しますか？中にある ${nested} 個も一緒に消えます。`
        : `${name} を削除しますか？`;
    if (confirm(message)) remove(entityId);
  };

  const modeAt = (event: React.DragEvent, targetId: string | null): DropMode => {
    if (targetId === null) return "inside";
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.height === 0 ? 0.5 : (event.clientY - rect.top) / rect.height;
    if (ratio < 0.28) return "before";
    if (ratio > 0.72) return "after";
    return "inside";
  };

  /**
   * ドラッグした Entity を置く先。プレハブの中では、いちばん上の Entity は動かせず、
   * いちばん上の行（プレハブそのもの）や、いちばん上の Entity の前後に落としたものは、いちばん上の Entity の下の末尾に入る。
   */
  const placeFor = (id: string, targetId: string | null, mode: DropMode) => {
    if (!prefab) return dropPlacement(nodes, id, targetId, mode);
    if (id === prefab.root) return null;
    const place = dropPlacement(nodes, id, targetId, mode);
    if (!place || place.parent !== null) return place;
    return {
      parent: prefab.root,
      index: nodes.filter((n) => n.parent === prefab.root && n.id !== id).length,
    };
  };

  const hoverDrop = (event: React.DragEvent, targetId: string | null) => {
    const id = dragId.current;
    // プレハブから来た Entity の所には、いまは置けない
    if (!editing || fromPrefab(targetId)) return;
    if (!id) {
      // Resources からプレハブをドラッグしてきた：落とした所に、インスタンスを置く。
      // プレハブの中にインスタンスを置くのは、まだ（入れ子の画面は、あとの段階）
      if (prefab || !event.dataTransfer.types.includes(PREFAB_DRAG)) return;
      event.preventDefault();
      event.stopPropagation();
      const key = targetId ?? "root";
      setDropOver((cur) =>
        cur?.id === key && cur.mode === "inside" ? cur : { id: key, mode: "inside" },
      );
      return;
    }
    const mode = modeAt(event, targetId);
    if (!placeFor(id, targetId, mode)) return;
    event.preventDefault();
    event.stopPropagation();
    const key = targetId ?? "root";
    setDropOver((cur) => (cur?.id === key && cur.mode === mode ? cur : { id: key, mode }));
  };

  const finishDrop = (event: React.DragEvent, targetId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const id = dragId.current;
    dragId.current = null;
    setDropOver(null);
    if (!id) {
      const dropped = event.dataTransfer.getData(PREFAB_DRAG);
      if (!editing || prefab || !dropped || fromPrefab(targetId)) return;
      try {
        setError(null);
        const made = project.addInstance({
          output: outputId,
          prefab: dropped,
          parent: targetId,
          // いちばん上に置くときは、見ている先に置く。子にするときは、親の所に置く
          ...(targetId === null ? { position: viewPoint?.() ?? [0, 1, 0] } : {}),
        });
        openOf(targetId ?? outputId);
        select({ kind: "entity", id: made });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    const mode = modeAt(event, targetId);
    const place = placeFor(id, targetId, mode);
    if (!place) return;
    try {
      setError(null);
      project.placeEntity(id, place.parent, place.index);
      openOf(place.parent ?? ownerId);
      if (mode === "inside" && targetId) openOf(targetId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const children = (parent: EntityId | null) => nodes.filter((n) => n.parent === parent);
  const descendantKinds = (id: string): ChangeKind[] => {
    const out: ChangeKind[] = [];
    const seen = new Set<string>([id]);
    const walk = (parent: string) => {
      for (const n of nodes) {
        if (n.parent !== parent || seen.has(n.id)) continue;
        seen.add(n.id);
        const kind = kindOf.get(n.id);
        if (kind) out.push(kind);
        walk(n.id);
      }
    };
    walk(id);
    return out;
  };

  const renderTree = (parent: EntityId | null, depth: number): React.ReactNode =>
    children(parent).map((n) => {
      const kids = children(n.id);
      const open = !closed[n.id];
      const mark = treeMark(
        kindOf.get(n.id) ?? null,
        !open && kids.length > 0,
        descendantKinds(n.id),
      );
      return (
        <li key={n.id}>
          {/* 行の中に開閉・複製・削除のボタンがあるので、行自体はボタンにしない */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: ドロップ先。操作は中のボタン */}
          <div
            className={styles.node}
            style={{ paddingLeft: 4 + depth * 14 }}
            data-from-prefab={n.fromPrefab || undefined}
            data-instance={n.instance !== undefined || undefined}
            data-current={selectedEntity === n.id || undefined}
            data-drop={dropOver?.id === n.id ? dropOver.mode : undefined}
            onDragOver={(e) => hoverDrop(e, n.id)}
            onDrop={(e) => finishDrop(e, n.id)}
          >
            {kids.length > 0 ? (
              <button
                type="button"
                className={styles.fold}
                data-no-drag=""
                aria-expanded={open}
                aria-label={open ? `${n.name} を閉じる` : `${n.name} を開く`}
                onClick={() => setClosed((c) => ({ ...c, [n.id]: open }))}
              >
                <Chevron open={open} />
              </button>
            ) : (
              <span className={styles.fold} />
            )}
            {/* プレハブの中の Entity の変化は、丸だけを出す（戻すのは、プレハブまるごと） */}
            <ChangeMark
              kind={mark.kind}
              nested={mark.nested}
              {...(prefab ? {} : { target: { entry: `entity:${n.id}` } })}
            />
            <button
              type="button"
              className={styles.nodeName}
              draggable={editing && !n.fromPrefab && !n.root}
              aria-current={selectedEntity === n.id || undefined}
              title={
                n.fromPrefab
                  ? `${n.name}（プレハブから来た Entity）`
                  : n.root
                    ? `${n.name}（プレハブのいちばん上の Entity。インスタンスの Entity が、これに当たります）`
                    : editing
                      ? `${n.name}（上か下で並び替え、真ん中に置くと子にする）`
                      : n.name
              }
              onClick={() => {
                setDupFor(null);
                select({ kind: "entity", id: n.id });
              }}
              onDragStart={(e) => {
                if ((e.target as HTMLElement).closest("[data-no-drag]")) {
                  e.preventDefault();
                  return;
                }
                dragId.current = n.id;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", n.id);
              }}
              onDragEnd={() => {
                dragId.current = null;
                setDropOver(null);
              }}
            >
              {n.name}
            </button>
            <BadgeDot badge={badgeFor(problems.get(n.id), "中")} inline />
            {n.instance !== undefined && (
              <span className={ui.badge} title="プレハブのインスタンス">
                プレハブ
              </span>
            )}
            {n.root && (
              <span className={ui.badge} title="プレハブのいちばん上の Entity">
                いちばん上
              </span>
            )}
            {editing && !n.fromPrefab && !n.root && (
              <span className={styles.actions} data-no-drag="">
                {n.instance !== undefined && (
                  <OpenPrefabButton
                    name={n.name}
                    // アウトプットのインスタンスから開いたら、その横に出す
                    onOpen={() => openPrefab(n.instance ?? "", prefab ? null : n.id)}
                  />
                )}
                <button
                  type="button"
                  className={ui.iconBtn}
                  aria-label={`${n.name} を複製`}
                  aria-haspopup={kids.length > 0 ? "menu" : undefined}
                  aria-expanded={kids.length > 0 ? dupFor === n.id : undefined}
                  title="複製"
                  onClick={(e) => {
                    setMenu(false);
                    if (kids.length === 0) {
                      duplicate(n.id, false);
                      return;
                    }
                    if (dupFor === n.id) {
                      setDupFor(null);
                      setDupAnchor(null);
                      return;
                    }
                    setDupFor(n.id);
                    setDupAnchor(e.currentTarget);
                  }}
                >
                  <CopyIcon />
                </button>
                <button
                  type="button"
                  className={ui.iconBtn}
                  aria-label={`${n.name} を削除`}
                  title="削除"
                  onClick={() => askRemove(n.id, n.name)}
                >
                  ✕
                </button>
              </span>
            )}
            {dupFor === n.id && dupAnchor && (
              <FloatMenu anchor={dupAnchor} align="end" onClose={() => setDupFor(null)}>
                <li>
                  <button
                    type="button"
                    className={ui.menuItem}
                    onClick={() => duplicate(n.id, false)}
                  >
                    これだけ複製
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={ui.menuItem}
                    onClick={() => duplicate(n.id, true)}
                  >
                    中も含めて複製
                  </button>
                </li>
              </FloatMenu>
            )}
          </div>
          {open && kids.length > 0 && <ul className={ui.list}>{renderTree(n.id, depth + 1)}</ul>}
        </li>
      );
    });

  const ownerOpen = !closed[ownerId];
  const ownerMark = treeMark(
    ownerKind,
    !ownerOpen && nodes.some((n) => n.parent === null),
    nodes.filter((n) => kindOf.get(n.id)).map((n) => kindOf.get(n.id) as ChangeKind),
  );

  return (
    <nav className={styles.tree} aria-label="Hierarchy">
      <div className={styles.treeHead}>
        <h3 className={ui.sectionTitle}>Hierarchy</h3>
        <div>
          <button
            type="button"
            className={ui.iconBtn}
            aria-label="Entity を追加"
            title="Entity を追加"
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={!editing}
            onClick={(e) => {
              setDupFor(null);
              setDupAnchor(null);
              setMenuAnchor(e.currentTarget);
              setMenu((open) => !open);
            }}
          >
            ＋
          </button>
          {menu && menuAnchor && (
            <FloatMenu anchor={menuAnchor} align="start" onClose={() => setMenu(false)}>
              {NEW_ENTITIES.map((spec) => (
                <li key={spec.label}>
                  <button type="button" className={ui.menuItem} onClick={() => add(spec)}>
                    {spec.label}
                  </button>
                </li>
              ))}
            </FloatMenu>
          )}
        </div>
      </div>
      {error && <p className={ui.error}>{error}</p>}
      {prefab && (
        <div className={styles.prefabBar}>
          <span className={styles.prefabBarText}>プレハブを編集中</span>
          <button type="button" className={ui.btn} onClick={closePrefab}>
            アウトプットに戻る
          </button>
        </div>
      )}
      <ul className={ui.list}>
        <li>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: ドロップ先。操作は中のボタン */}
          <div
            className={styles.node}
            data-current={ownerSelected || undefined}
            data-drop={dropOver?.id === "root" ? dropOver.mode : undefined}
            onDragOver={(e) => hoverDrop(e, null)}
            onDrop={(e) => finishDrop(e, null)}
          >
            {nodes.length > 0 ? (
              <button
                type="button"
                className={styles.fold}
                aria-expanded={ownerOpen}
                aria-label={ownerOpen ? "中の Entity を閉じる" : "中の Entity を開く"}
                onClick={() => setClosed((c) => ({ ...c, [ownerId]: ownerOpen }))}
              >
                <Chevron open={ownerOpen} />
              </button>
            ) : (
              <span className={styles.fold} />
            )}
            <ChangeMark
              kind={ownerMark.kind}
              nested={ownerMark.nested}
              target={{ entry: prefab ? `prefab:${prefab.id}` : `output:${outputId}` }}
            />
            <button
              type="button"
              className={styles.nodeName}
              aria-current={ownerSelected || undefined}
              onClick={() =>
                select(
                  prefab ? { kind: "prefab", id: prefab.id } : { kind: "output", id: outputId },
                )
              }
            >
              <b>{prefab ? prefab.name : (output?.name ?? "（アウトプットなし）")}</b>
            </button>
            {prefab ? (
              <>
                <BadgeDot badge={badgeFor(resourceProblems.get(prefab.id))} inline />
                <span className={ui.badge}>プレハブ</span>
              </>
            ) : (
              <>
                <BadgeDot badge={badgeFor(problems.get(outputId), "中")} inline />
                <span className={ui.badge}>{output?.kind === "world" ? "world" : "item"}</span>
              </>
            )}
          </div>
        </li>
        {ownerOpen && renderTree(null, 1)}
      </ul>
      {nodes.length === 0 && <p className={ui.empty}>＋ から Entity を追加できます</p>}
    </nav>
  );
}

/** インスタンスの行から、そのプレハブを開く */
function OpenPrefabButton({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={ui.iconBtn}
      aria-label={`${name} のプレハブを開く`}
      title="プレハブを開く"
      onClick={onOpen}
    >
      <OpenIcon />
    </button>
  );
}

/** 開く（枠から外へ出る矢印） */
function OpenIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M6.5 3H3.2A1.2 1.2 0 0 0 2 4.2v8.6A1.2 1.2 0 0 0 3.2 14h8.6a1.2 1.2 0 0 0 1.2-1.2V9.5M9 2h5v5M14 2 7.5 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 初期値に戻す（左回りの矢印） */
function ResetIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      style={{ transform: open ? undefined : "rotate(-90deg)" }}
    >
      <path
        d="M4 6l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** KokoState を追加（積み木に＋） */
function AddKokoIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect
        x="1.5"
        y="4.5"
        width="9"
        height="9"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M12.5 1v5M10 3.5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ChildIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="8"
        height="8"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="6.5"
        y="6.5"
        width="8"
        height="8"
        rx="1.2"
        fill="var(--c-paper, #fff)"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function SystemsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M2.5 4h11M2.5 8h11M2.5 12h7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect
        x="5.5"
        y="5.5"
        width="8"
        height="8"
        rx="1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M10.5 5.5V3.2A1.2 1.2 0 0 0 9.3 2H3.2A1.2 1.2 0 0 0 2 3.2v6.1a1.2 1.2 0 0 0 1.2 1.2H5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Properties

/** 丸に、差分と「戻す」の相手を付ける（相手がなければ、丸だけ） */
const withTarget = (target: { entry: string; part: string } | undefined) =>
  target ? { target } : {};

function Properties() {
  const selection = useWorkspace((s) => s.selection);
  if (!selection) {
    return (
      <div className={styles.scrollPane}>
        <div className={ui.section}>
          <p className={ui.muted}>
            Hierarchy
            で選ぶと、ここに設定が出ます。空間ではクロスヘアを物に合わせてクリックしても選べます。KokoState・マテリアル・スクリプトは、Resources
            で選ぶと詳細パネルに出ます。
          </p>
        </div>
      </div>
    );
  }
  if (selection.kind === "entity") return <EntityProperties id={selection.id} />;
  return (
    <div className={styles.scrollPane}>
      <DefinitionProperties selection={selection} />
    </div>
  );
}

function EntityProperties({ id }: { id: EntityId }) {
  const { mode, runtime, stop, outputId, select, openDetail, openPrefab } = useWorkspace();
  const queryOf = useSystemQuery();
  const project = useProject();
  const canEdit = useCanEdit();
  const saved = useSavedFiles();
  const target = useEditTarget();
  useWorkspace((s) => (s.mode === "edit" ? s.rev : s.simRev));
  const [error, setError] = useState<string | null>(null);
  const [closedKoko, setClosedKoko] = useState<Record<string, boolean>>({});
  const focus = useWorkspace((s) => s.focusField);
  /** 問題の場所から移ってきたとき、少しの間目立たせる KokoState か欄（"koko" か "koko:field"） */
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  // 問題の場所から移ってきたら、その KokoState を開き、欄まで送って目立たせる。
  // 一度使ったら記録を消す（あとで選び直したときに、また目立たせないように）
  useEffect(() => {
    if (!focus || focus.entity !== id) return;
    useWorkspace.setState({ focusField: null });
    setClosedKoko((c) => ({ ...c, [`${id}:${focus.koko}`]: false }));
    const key = focus.field ? `${focus.koko}:${focus.field}` : focus.koko;
    setFlash(key);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-focus-key="${CSS.escape(`${id}:${key}`)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1600);
  }, [focus, id]);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  const [dupAnchor, setDupAnchor] = useState<HTMLElement | null>(null);
  const [systemAnchor, setSystemAnchor] = useState<HTMLElement | null>(null);
  /** 「プレハブにする」の確認を出している Entity と、そのボタン（ほかの Entity を選んだら、出さない） */
  const [ask, setAsk] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const registry = project.registry();
  // 開いているプレハブ（ADR 0076）。開いている間は、プレハブの中の Entity を直す
  const prefab = target.prefabId ? project.prefab(target.prefabId) : undefined;
  const ownerId = prefab ? prefab.id : outputId;
  // Edit：プレハブのインスタンスは、中身に展開した形で見せる（ADR 0076）
  const shown = mode === "edit" ? target.snapshot.entities.find((e) => e.id === id) : undefined;
  const origin = shown?.origin;
  /** プレハブから来た、インスタンスの中の Entity。いまは、インスタンスでは変えられない */
  const inside = origin !== undefined && origin.instance !== id;
  /** 開いているプレハブの、いちばん上の Entity。消せず、複製できず、ほかの下に付けられない */
  const isRoot = prefab !== undefined && prefab.root === id;
  const editing = canEdit && !inside;

  // Edit：制作データ、Play：実行中の World
  let entity: Pick<EntityDef, "id" | "name" | "parent" | "states"> | undefined;
  const rt = mode !== "edit" ? runtime() : null;
  if (rt) {
    if (rt.world.has(id)) {
      const states: Record<string, KokoStateValues> = {};
      for (const k of rt.world.statesOf(id)) states[k] = structuredClone(rt.world.get(id, k) ?? {});
      entity = { id, name: rt.nameOf(id), parent: rt.world.parentOf(id), states };
    }
  } else {
    entity = shown ?? project.findEntity(id);
  }
  if (!entity) {
    return (
      <div className={ui.section}>
        <p className={ui.muted}>
          選んだ Entity は見つかりません（削除されたか、実行中に消えました）。
        </p>
      </div>
    );
  }

  const choices = {
    materials: project.materials().map((m) => ({ id: m.id, name: m.name })),
    // states：KokoState の参照・フィールドの参照で、指せる Entity を絞るのに使う
    // インスタンスの中の Entity も指せる（展開した Entity の ID は、開き直しても変わらない）
    entities: target.snapshot.entities
      .filter((e) => e.output === ownerId)
      .map((e) => ({ id: e.id, name: e.name, states: Object.keys(e.states) })),
    assets: project.assets(),
  };
  const attached = Object.keys(entity.states);
  const order = (k: string) => (k === BUILTIN.Transform ? 0 : isBuiltin(k) ? 1 : 2);
  attached.sort((a, b) => order(a) - order(b));

  const safely = (fn: () => void) => {
    try {
      setError(null);
      fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const matchedSystems = project.systems().filter((s) => {
    const q = queryOf(s.id);
    const has = (k: { id: string | null }) => k.id !== null && attached.includes(k.id);
    return q.with.length > 0 && q.with.every(has) && !q.without.some(has);
  });
  // 制作データにある Entity（アウトプットのものか、開いているプレハブの中のもの）。展開で作ったものは、ない
  const projectEntity = mode === "edit" ? project.findEntity(id) : undefined;
  /** その KokoState を、ここで変えられるか。プレハブから来た KokoState は、いまはインスタンスでは変えられない */
  const editable = (koko: string) =>
    editing && (!origin || (projectEntity !== undefined && koko in projectEntity.states));
  const prefabName = origin ? (project.prefab(origin.prefab)?.name ?? "（消えたプレハブ）") : "";
  // 同じ持ち主（アウトプットか、開いているプレハブ）の、制作データにある Entity
  const peers = prefab ? project.prefabEntities(prefab.id) : project.entities(outputId);
  const kids = peers.filter((e) => e.parent === id);
  /** この Entity からプレハブを作れるか（アウトプットのふつうの Entity だけ） */
  const canMakePrefab = editing && !prefab && !origin && projectEntity !== undefined;
  const kokoKey = (koko: string) => `${id}:${koko}`;
  const allOpen = attached.length === 0 || attached.every((koko) => !closedKoko[kokoKey(koko)]);
  const keep: { saved: KeepMark[]; current: KeepMark[] } = prefab
    ? { saved: savedPrefabKeep(saved, prefab.id), current: prefab.keep }
    : { saved: savedKeep(saved, outputId), current: project.output(outputId)?.keep ?? [] };
  const marks = projectEntity ? entityChange(saved, projectEntity, keep) : null;
  /** 丸から開く差分と「戻す」。プレハブの中の Entity は、丸だけを出す（戻すのは、プレハブまるごと） */
  const markTarget = (part: string) => (prefab ? undefined : { entry: `entity:${id}`, part });

  const duplicate = (withChildren: boolean) => {
    setDupAnchor(null);
    safely(() => {
      // インスタンスを複製すると、同じプレハブのインスタンスが一つ増える
      const made = project.duplicateEntity(id, withChildren);
      if (made) select({ kind: "entity", id: made });
    });
  };

  const addChild = () =>
    safely(() => {
      const made = prefab
        ? project.addPrefabEntity({ prefab: prefab.id, name: "空の Entity", parent: id })
        : project.addEntity({ output: outputId, name: "空の Entity", parent: id });
      select({ kind: "entity", id: made });
    });

  const askRemove = () => {
    const nested = selfAndDescendants(peers, id).length - 1;
    const message =
      nested > 0
        ? `${entity.name} を削除しますか？中にある ${nested} 個も一緒に消えます。`
        : `${entity.name} を削除しますか？`;
    if (confirm(message))
      safely(() => {
        project.removeEntity(id);
        select(null);
      });
  };

  const toggleKokos = () => {
    setClosedKoko((cur) => {
      const next = { ...cur };
      for (const koko of attached) next[kokoKey(koko)] = allOpen;
      return next;
    });
  };

  return (
    <div className={styles.entityPane}>
      <div className={styles.entityHead}>
        <div className={styles.entityBar} role="toolbar" aria-label="Entity の操作">
          <button
            type="button"
            className={ui.iconBtn}
            aria-label={`${entity.name} を複製`}
            aria-haspopup={kids.length > 0 ? "menu" : undefined}
            aria-expanded={kids.length > 0 ? !!dupAnchor : undefined}
            title="複製"
            disabled={!editing || isRoot}
            onClick={(event) => {
              const button = event.currentTarget;
              setSystemAnchor(null);
              if (!editing || isRoot) return;
              if (kids.length === 0) {
                duplicate(false);
                return;
              }
              setDupAnchor((cur) => (cur ? null : button));
            }}
          >
            <CopyIcon />
          </button>
          <button
            type="button"
            className={ui.iconBtn}
            aria-label={`${entity.name} を削除`}
            title="削除"
            disabled={!editing || isRoot}
            onClick={askRemove}
          >
            ✕
          </button>
          <button
            type="button"
            className={ui.iconBtn}
            aria-label="子 Entity を作る"
            title="子 Entity を作る"
            disabled={!editing}
            onClick={addChild}
          >
            <ChildIcon />
          </button>
          {/* アウトプットの Entity（中の Entity を含む）から、プレハブを作る。先に、確認を出す */}
          <button
            type="button"
            className={ui.iconBtn}
            aria-label={`${entity.name} をプレハブにする`}
            aria-haspopup="dialog"
            aria-expanded={ask?.id === id}
            title={
              origin
                ? "プレハブにする（プレハブのインスタンスと、その中の Entity は、プレハブにできません）"
                : prefab
                  ? "プレハブにする（プレハブの中の Entity からは、作れません）"
                  : "プレハブにする"
            }
            disabled={!canMakePrefab}
            onClick={(event) => {
              const anchor = event.currentTarget;
              setDupAnchor(null);
              setSystemAnchor(null);
              setAsk((cur) => (cur?.id === id ? null : { id, anchor }));
            }}
          >
            <MakePrefabIcon />
          </button>
          <button
            type="button"
            className={ui.iconBtn}
            aria-label="KokoState を追加"
            title="KokoState を追加"
            disabled={!editing}
            onClick={() => useWorkspace.setState({ kokoPickerOpen: true })}
          >
            <AddKokoIcon />
          </button>
          <button
            type="button"
            className={ui.iconBtn}
            aria-label={allOpen ? "KokoState を閉じる" : "KokoState を開く"}
            aria-pressed={allOpen}
            title={allOpen ? "KokoState を閉じる" : "KokoState を開く"}
            disabled={attached.length === 0}
            onClick={toggleKokos}
          >
            <Chevron open={allOpen} />
          </button>
          <button
            type="button"
            className={ui.iconBtn}
            aria-label="適用されている System"
            aria-haspopup="menu"
            aria-expanded={!!systemAnchor}
            title="適用されている System"
            onClick={(event) => {
              const button = event.currentTarget;
              setDupAnchor(null);
              setSystemAnchor((cur) => (cur ? null : button));
            }}
          >
            <SystemsIcon />
          </button>
        </div>
        <MarkedLine kind={marks?.name ?? null} {...withTarget(markTarget("name"))}>
          <div className={ui.field}>
            <label className={ui.label} htmlFor={`name-${id}`}>
              Name
            </label>
            <input
              id={`name-${id}`}
              key={`${id}:${entity.name}`}
              className={ui.input}
              defaultValue={entity.name}
              disabled={!editing}
              onBlur={(e) =>
                e.target.value !== entity.name && project.renameEntity(id, e.target.value)
              }
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </div>
        </MarkedLine>
        {error && <p className={ui.error}>{error}</p>}
        {ask?.id === id && canMakePrefab && (
          <PrefabFromEntityAsk
            entityId={id}
            anchor={ask.anchor}
            onClose={() => setAsk(null)}
            onDone={() => setAsk(null)}
          />
        )}
      </div>
      <div className={styles.entityBody}>
        {origin && (
          <div className={ui.section}>
            <p className={ui.notice}>
              {inside
                ? `プレハブ「${prefabName}」から来た Entity です。いまは、インスタンスでは変えられません。プレハブを開くと直せます。`
                : `プレハブ「${prefabName}」のインスタンスです。名前と、場所・向き・大きさ（Transform）は、このインスタンスのものです。ほかの KokoState は、プレハブのものが出ています。プレハブを開くと直せます。`}
            </p>
            {mode === "edit" && project.prefab(origin.prefab) && (
              <div className={ui.toolbar}>
                <button
                  type="button"
                  className={ui.btn}
                  // アウトプットのインスタンスから開いたら、その横に出す
                  onClick={() => openPrefab(origin.prefab, prefab ? null : origin.instance)}
                >
                  プレハブを開く
                </button>
              </div>
            )}
          </div>
        )}
        {isRoot && (
          <div className={ui.section}>
            <p className={ui.notice}>
              プレハブのいちばん上の Entity です。インスタンスの Entity
              が、これに当たります。消したり、ほかの Entity
              の下に付けたりはできません。向きと大きさ（Transform）は、インスタンスを置くときに写します。
            </p>
          </div>
        )}
        {mode !== "edit" && (
          <div className={ui.section}>
            <p className={ui.notice}>
              Play mode 中は編集できません。Play mode 中の出来事はプロジェクトに残りません。
            </p>
            <div className={ui.toolbar}>
              <button type="button" className={ui.btn} onClick={stop}>
                Edit mode に戻る
              </button>
            </div>
          </div>
        )}
        {editing && !isRoot && (
          <div className={ui.section}>
            <MarkedLine kind={marks?.parent ?? null} {...withTarget(markTarget("place"))}>
              <div className={ui.field}>
                <label className={ui.label} htmlFor={`parent-${id}`}>
                  親
                </label>
                <select
                  id={`parent-${id}`}
                  className={ui.select}
                  value={entity.parent ?? ""}
                  onChange={(e) => safely(() => project.setParent(id, e.target.value || null))}
                >
                  {/* プレハブの中の Entity は、いちばん上の Entity の下に入る（親なしにはできない） */}
                  {!prefab && <option value="">（なし）</option>}
                  {/* 親にできるのは、制作データにある Entity（インスタンスの中の Entity の下に付けるのは、まだ） */}
                  {peers
                    .filter((e) => e.id !== id)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </select>
              </div>
            </MarkedLine>
          </div>
        )}

        {attached.map((koko) => {
          const def = registry.get(koko);
          if (!def) return null;
          const values = entity.states[koko] ?? {};
          const closed = !!closedKoko[kokoKey(koko)];
          return (
            <section
              key={koko}
              className={styles.kokoCard}
              aria-label={def.name}
              data-focus-key={`${id}:${koko}`}
              data-flash={flash === koko || undefined}
            >
              <div className={styles.kokoHead}>
                <button
                  type="button"
                  className={styles.fold}
                  aria-expanded={!closed}
                  aria-label={closed ? `${def.name} を開く` : `${def.name} を閉じる`}
                  onClick={() => setClosedKoko((cur) => ({ ...cur, [kokoKey(koko)]: !closed }))}
                >
                  <Chevron open={!closed} />
                </button>
                <ChangeMark
                  kind={marks?.states[koko]?.kind ?? null}
                  {...withTarget(markTarget(`state:${koko}`))}
                />
                <span className={styles.kokoIcon}>
                  <KokoRoleIcon role={def.role} />
                </span>
                <h4 className={styles.kokoName}>{def.name}</h4>
                {def.builtin ? (
                  <span className={ui.badge}>Built-in</span>
                ) : packageAliasOf(project, koko) ? (
                  <span className={ui.badgeBrand} title="依存のライブラリの KokoState">
                    @{packageAliasOf(project, koko)}
                  </span>
                ) : (
                  <span className={ui.badgeBrand}>KokoState</span>
                )}
                <span className={styles.kokoSpacer} />
                {editable(koko) && def.fields.length > 0 && (
                  <button
                    type="button"
                    className={ui.iconBtn}
                    aria-label={`${def.name} を初期値に戻す`}
                    title="初期値に戻す"
                    onClick={() =>
                      safely(() =>
                        project.transact(() => {
                          for (const f of def.fields)
                            project.setField(
                              id,
                              koko,
                              f.id,
                              structuredClone(f.default) as FieldValue,
                            );
                        }),
                      )
                    }
                  >
                    <ResetIcon />
                  </button>
                )}
                {editable(koko) && (
                  <button
                    type="button"
                    className={ui.iconBtn}
                    aria-label={`${def.name} を外す`}
                    title="外す"
                    onClick={() => {
                      if (window.confirm(`${def.name} を外しますか？`))
                        project.removeState(id, koko);
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
              {closed ? null : (
                <>
                  {KOKO_HINT[koko] && <p className={ui.muted}>{KOKO_HINT[koko]}</p>}
                  {def.fields.length === 0 && (
                    <p className={ui.muted}>フィールドなし（タグとして使う KokoState）</p>
                  )}
                  {def.fields.map((f) => (
                    <div
                      key={f.id}
                      className={styles.fieldRow}
                      data-focus-key={`${id}:${koko}:${f.id}`}
                      data-flash={flash === `${koko}:${f.id}` || undefined}
                    >
                      <ChangeMark
                        kind={marks?.states[koko]?.fields[f.id] ?? null}
                        {...withTarget(markTarget(`field:${koko}:${f.id}`))}
                      />
                      <FieldInput
                        koko={koko}
                        field={f}
                        value={(f.id in values ? values[f.id] : f.default) as FieldValue}
                        choices={choices}
                        disabled={!editable(koko)}
                        onChange={(v) => safely(() => project.setField(id, koko, f.id, v))}
                      />
                      {mode === "edit" && (
                        <KeepToggle
                          entity={id}
                          koko={koko}
                          field={f.id}
                          label={`${def.name}.${f.name}`}
                          disabled={!editable(koko)}
                          prefab={prefab?.id ?? null}
                        />
                      )}
                    </div>
                  ))}
                </>
              )}
            </section>
          );
        })}
      </div>
      {dupAnchor && (
        <FloatMenu anchor={dupAnchor} align="start" onClose={() => setDupAnchor(null)}>
          <li>
            <button type="button" className={ui.menuItem} onClick={() => duplicate(false)}>
              これだけ複製
            </button>
          </li>
          <li>
            <button type="button" className={ui.menuItem} onClick={() => duplicate(true)}>
              中も含めて複製
            </button>
          </li>
        </FloatMenu>
      )}
      {systemAnchor && (
        <FloatMenu
          anchor={systemAnchor}
          align="start"
          className={styles.menuScroll}
          onClose={() => setSystemAnchor(null)}
        >
          {matchedSystems.length === 0 ? (
            <li>
              <button type="button" className={ui.menuItem} disabled>
                マッチする System はありません
              </button>
            </li>
          ) : (
            matchedSystems.map((system) => (
              <li key={system.id}>
                <button
                  type="button"
                  className={ui.menuItem}
                  onClick={() => {
                    setSystemAnchor(null);
                    openDetail({ kind: "system", id: system.id });
                  }}
                >
                  {system.name}
                </button>
              </li>
            ))
          )}
        </FloatMenu>
      )}
    </div>
  );
}

/**
 * 状態維持のマーク：適用したとき、このフィールドの実行値を引き継ぐ（要件 §7）。
 * マークはアウトプットごとに持つので、同じ KokoState を使う別のアウトプットには波及しない。
 * プレハブの中の Entity の印は、プレハブが持つ（インスタンスを置いたアウトプットの印に、足し合わされる。ADR 0076）。
 */
function KeepToggle(props: {
  entity: string;
  koko: string;
  field: string;
  label: string;
  disabled: boolean;
  /** 開いているプレハブ（アウトプットの Entity なら null） */
  prefab: string | null;
}) {
  const project = useProject();
  const outputId = useWorkspace((s) => s.outputId);
  useWorkspace((s) => s.rev);
  const output = project.output(outputId);
  const prefab = props.prefab ? project.prefab(props.prefab) : undefined;
  const keep = props.prefab ? prefab?.keep : output?.keep;
  if (!keep) return null;
  const match = (k: { entity: string; koko: string; field: string }) =>
    k.entity === props.entity && k.koko === props.koko && k.field === props.field;
  const on = keep.some(match);
  const next = on
    ? keep.filter((k) => !match(k))
    : [...keep, { entity: props.entity, koko: props.koko, field: props.field }];
  return (
    <button
      type="button"
      className={on ? styles.keepOn : styles.keep}
      aria-pressed={on}
      aria-label={`${props.label} を適用時に引き継ぐ`}
      title={on ? "適用時に実行値を引き継ぐ（オン）" : "適用時に実行値を引き継ぐ（オフ）"}
      disabled={props.disabled}
      onClick={() => {
        if (prefab) project.updatePrefab({ ...prefab, keep: next });
        else if (output) project.updateOutput({ ...output, keep: next });
      }}
    >
      維持
    </button>
  );
}
