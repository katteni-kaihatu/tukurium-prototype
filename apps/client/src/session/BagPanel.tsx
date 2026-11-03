import { parsePackageResourceId } from "@tukurium/repo-model";
import type { BagItem } from "@tukurium/runtime";
import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { useWorkspace } from "../workspace/store";
import ui from "../workspace/ui.module.css";
import { useSessionWorld } from "./sessionWorld";

/** ホストは手元の Simulation が持つので、少し間をおいて読み直す */
function useTick(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** その種類がどのライブラリのものか（`pkg:<Package ID>@<版>/…` から） */
function libraryOf(type: string): string {
  const ref = parsePackageResourceId(type);
  return ref ? `${ref.packageId} v${ref.version}` : type;
}

function BagList({ items, label }: { items: BagItem[]; label: string }) {
  if (items.length === 0) return <p className={ui.muted}>空です</p>;
  return (
    <ul className={ui.list} aria-label={label}>
      {items.map((it, i) => (
        // 同じ種類・同じ値の物が並ぶので、並び順も鍵にする
        // biome-ignore lint/suspicious/noArrayIndexKey: 中身に ID がない（1 個ずつ数える）
        <li key={`${it.type}:${i}`} className={ui.item} style={{ cursor: "default" }}>
          <span className={ui.itemName}>
            {it.name}
            <span className={ui.muted}>
              {" "}
              ·{" "}
              {Object.entries(it.values)
                .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
                .join(" / ") || "値なし"}
            </span>
          </span>
          <span className={ui.badge} title="この種類を公開しているライブラリ">
            {libraryOf(it.type)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 自分のバッグ（ADR 0018）。見えるのは自分のバッグだけ。セッションの間だけ残る。
 * ワークスペースを再生しているときは、その再生のバッグも出す（作者が試すための別のバッグ）。
 */
export function BagPanel() {
  useTick(500);
  const me = useApp((s) => s.me?.id ?? "");
  // セレクタでは毎回作り直す値を返さない（ストアの物をそのまま選び、表示のときに読む）
  const sessionSim = useSessionWorld((s) => (s.isHost ? s.sim : null));
  const sessionRemote = useSessionWorld((s) => s.remote);
  const playing = useWorkspace((s) => s.mode !== "edit");
  const playSim = useWorkspace((s) => (s.isHost ? s.sim : null));
  const playRemote = useWorkspace((s) => s.remote);
  const session = sessionSim ? sessionSim.bagsSnapshot() : (sessionRemote?.bags ?? {});
  const play = playSim ? playSim.bagsSnapshot() : (playRemote?.bags ?? {});
  return (
    <>
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>セッションのバッグ</h3>
        <p className={ui.muted}>
          E で拾った物が入ります。どの作品でも同じバッグで、セッションが続く間だけ残ります。
        </p>
        <BagList items={session[me] ?? []} label="セッションのバッグ" />
      </div>
      {playing && (
        <div className={ui.section}>
          <h3 className={ui.sectionTitle}>再生中のバッグ（ワークスペース）</h3>
          <BagList items={play[me] ?? []} label="再生中のバッグ" />
        </div>
      )}
    </>
  );
}
