import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChangeDetail, RevertIcon } from "./ChangeList";
import type { ChangeKind } from "./changeMarks";
import { describeDiff } from "./diffView";
import styles from "./history.module.css";
import { useProject } from "./hooks";
import { entryPart } from "./revert";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useRevert } from "./useRevert";

/**
 * 丸が指す差分。entry は保存パネルの差分の id（"entity:<id>" など）、
 * part はその中の部分（DiffLine の part）。part がなければ丸ごと。
 */
export interface ChangeTarget {
  entry: string;
  part?: string;
}

/** 行の左端に、変化の丸を置く。変化がない行も透けた丸にして、文字の開始を揃える。 */
export function MarkedLine({
  kind,
  target,
  children,
}: {
  kind: ChangeKind | null;
  target?: ChangeTarget;
  children: ReactNode;
}) {
  return (
    <div className={ui.markedLine}>
      <ChangeMark kind={kind} target={target} />
      <div className={ui.markedBody}>{children}</div>
    </div>
  );
}

/**
 * 新しいものは緑、変わったものは黄色、変化がないものは中が透けた丸。色だけに頼らず名前も付ける。
 * target を渡すと、マウスを載せたときに、どう変わったかと「元に戻す」を出す。
 */
export function ChangeMark({
  kind,
  nested = false,
  target,
}: {
  kind: ChangeKind | null;
  /** 閉じた階層の中にある変化 */
  nested?: boolean;
  target?: ChangeTarget;
}) {
  const edit = useWorkspace((s) => s.mode === "edit");
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const label =
    kind === null
      ? null
      : nested
        ? kind === "added"
          ? "中に新しいものがあります"
          : "中に変わったものがあります"
        : kind === "added"
          ? "新しい"
          : "変わった";
  if (!label || !kind) {
    return <span className={edit ? ui.changeMark : ui.changeGap} aria-hidden="true" />;
  }
  if (!target || nested || !edit) {
    return (
      <span
        className={ui.changeMark}
        data-change={kind}
        title={label}
        role="img"
        aria-label={label}
      />
    );
  }
  const stay = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(true);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 180);
  };
  return (
    <>
      <button
        type="button"
        ref={anchor}
        className={`${ui.changeMark} ${ui.changeMarkLive}`}
        data-change={kind}
        aria-label={`${label}。どう変わったかを見る`}
        aria-expanded={open}
        onMouseEnter={stay}
        onMouseLeave={leave}
        onFocus={stay}
        onBlur={leave}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && anchor.current && (
        <ChangePop
          anchor={anchor.current}
          label={label}
          target={target}
          onEnter={stay}
          onLeave={leave}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** 丸の下に、どう変わったか（保存パネルの差分と同じ書き方）と「元に戻す」を出す */
function ChangePop({
  anchor,
  label,
  target,
  onEnter,
  onLeave,
  onClose,
}: {
  anchor: HTMLElement;
  label: string;
  target: ChangeTarget;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const project = useProject();
  const rev = useWorkspace((s) => s.rev);
  const { head, canRevert, revert } = useRevert();
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は中身が変わった合図
  const entry = useMemo(() => {
    if (!head) return null;
    const found = describeDiff(head, { ...project.snapshot(), name: project.name }).find(
      (e) => e.id === target.entry,
    );
    return found ? entryPart(found, target.part) : null;
  }, [head, project, rev, target.entry, target.part]);

  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const mark = anchor.getBoundingClientRect();
      const size = el.getBoundingClientRect();
      let top = mark.bottom + 6;
      if (top + size.height > window.innerHeight - 8) {
        top = Math.max(8, mark.top - 6 - size.height);
      }
      const left = Math.max(8, Math.min(mark.left - 10, window.innerWidth - size.width - 8));
      setPos((cur) => (cur && cur.top === top && cur.left === left ? cur : { top, left }));
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  });

  const empty = !entry || (entry.lines.length === 0 && !entry.code?.length && !entry.preview);
  const revertable = canRevert(target.entry, target.part);
  return createPortal(
    <div
      ref={box}
      className={ui.changePop}
      role="dialog"
      aria-label={`${label}：どう変わったか`}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className={ui.changePopHead}>
        <span
          className={ui.changeMark}
          data-change={entry?.kind === "added" ? "added" : "modified"}
        />
        <span className={ui.changePopTitle}>{label}</span>
        {revertable && (
          <button
            type="button"
            className={ui.btn}
            onFocus={onEnter}
            onClick={() => {
              const failed = revert(target.entry, target.part);
              setError(failed);
              if (!failed) onClose();
            }}
          >
            <RevertIcon />
            元に戻す
          </button>
        )}
      </div>
      {empty ? (
        <p className={styles.emptyDiff}>
          {head ? "くわしい中身はありません" : "保存した内容を読み込んでいます…"}
        </p>
      ) : (
        entry && <ChangeDetail entry={entry} />
      )}
      {error && <p className={ui.error}>{error}</p>}
    </div>,
    document.body,
  );
}
