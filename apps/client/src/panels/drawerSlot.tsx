import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/**
 * 付属パネル（ADR 0044）の受け皿。付属パネルの側に <DrawerSlot name> を置き、
 * 中身は本体のパネルから <InDrawer name> で portal する。状態（選んだ差分など）を本体に置いたまま、
 * 見た目だけ付属パネルへ出せる。
 */
const slots = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const fn of listeners) fn();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function DrawerSlot({ name }: { name: string }) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) slots.set(name, el);
      else slots.delete(name);
      notify();
    },
    [name],
  );
  return <div ref={ref} style={{ display: "contents" }} />;
}

/** 付属パネルの受け皿へ中身を出す。付属パネルがたたまれている間は何も描かない */
export function InDrawer({ name, children }: { name: string; children: ReactNode }) {
  const el = useSyncExternalStore(subscribe, () => slots.get(name) ?? null);
  return el ? createPortal(children, el) : null;
}
