import type { ProjectSnapshot } from "@tukurium/repo-model";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api, type CommitInfo } from "../net/api";
import { ChangeList, ChangeSide } from "./ChangeList";
import { type DiffEntry, describeDiff } from "./diffView";
import styles from "./history.module.css";
import { layoutLog } from "./logGraph";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useHistory } from "./useHistory";

const COL = 16;
const LANE_COLORS = ["#603d56", "#2a6b8a", "#1f6b47", "#8a5a2a", "#6b3d7a"];
const laneColor = (index: number) => LANE_COLORS[index % LANE_COLORS.length] ?? LANE_COLORS[0];

const UNSAVED = "unsaved";

/**
 * 履歴：左は Git の log のようなグラフ（いちばん上は未保存）、まんなかは選んだ記録の詳細と差分、
 * 右は選んだ差分の中身。
 * 未保存の横の印から、保存パネルを開く。
 */
export function HistoryPanel() {
  const history = useHistory();
  const openSave = useWorkspace((s) => s.openSave);
  const [selected, setSelected] = useState(UNSAVED);
  const [diff, setDiff] = useState<DiffEntry[]>([]);
  /** いま diff がどの記録のものか。選んだ記録と違う間は、空の差分を出さない */
  const [diffFor, setDiffFor] = useState(UNSAVED);
  const [diffError, setDiffError] = useState<string | null>(null);
  /** 選んだ差分。記録ごとに覚える（別の記録を選んだら、何も選んでいない状態から） */
  const [picked, setPicked] = useState<{ of: string; id: string } | null>(null);
  const rows = useMemo(
    () => layoutLog(history.commits.map((c) => ({ oid: c.oid, parents: c.parents }))),
    [history.commits],
  );

  useEffect(() => {
    if (selected !== UNSAVED && !history.commits.some((c) => c.oid === selected)) {
      setSelected(UNSAVED);
    }
  }, [history.commits, selected]);

  useEffect(() => {
    if (!history.repoId || selected === UNSAVED) {
      setDiff([]);
      setDiffFor(UNSAVED);
      setDiffError(null);
      return;
    }
    let alive = true;
    setDiffError(null);
    const oid = selected;
    const parent = history.commits.find((c) => c.oid === oid)?.parents[0];
    const repoId = history.repoId;
    Promise.all([
      parent ? api.snapshot(repoId, parent) : Promise.resolve(emptySnapshot()),
      api.snapshot(repoId, oid),
    ]).then(
      ([before, after]) => {
        if (!alive) return;
        setDiff(describeDiff(before, after));
        setDiffFor(oid);
      },
      (e: Error) => {
        if (!alive) return;
        setDiff([]);
        setDiffFor(oid);
        setDiffError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [history.repoId, history.commits, selected]);

  if (!history.repoId) {
    return <p className={ui.empty}>このワークスペースにはプロジェクトがありません</p>;
  }

  const diffing = selected !== UNSAVED && diffFor !== selected;
  const tip = rows[0];
  const width = tip ? Math.max(tip.incoming.length, tip.outgoing.length) : 1;
  const tipLane = tip?.lane ?? 0;
  const pickedCommit = history.commits.find((c) => c.oid === selected) ?? null;
  const shown = selected === UNSAVED || !pickedCommit ? history.entries : diffing ? [] : diff;
  const pickedId = picked?.of === selected ? picked.id : null;
  const pickedEntry = shown.find((e) => e.id === pickedId) ?? null;
  const select = (id: string) => setPicked({ of: selected, id });

  return (
    <div className={styles.frame}>
      <div className={styles.split}>
        <div className={styles.log}>
          <ol className={styles.logList} aria-label="履歴">
            <li className={styles.entry} data-selected={selected === UNSAVED || undefined}>
              <button
                type="button"
                className={styles.entryBtn}
                aria-pressed={selected === UNSAVED}
                onClick={() => setSelected(UNSAVED)}
              >
                <Graph
                  lane={tipLane}
                  incoming={Array.from({ length: width }, () => false)}
                  outgoing={Array.from(
                    { length: width },
                    (_, i) => i === tipLane && tip !== undefined,
                  )}
                  forks={[]}
                  hollow
                  mark={history.entries.length > 0 ? "#8a5a2a" : laneColor(tipLane)}
                />
                <span className={styles.entryText}>
                  <span className={styles.entryTitle}>未保存</span>
                  <span className={styles.entryMeta}>
                    {history.ready
                      ? history.entries.length > 0
                        ? `差分 ${history.entries.length} 件`
                        : "差分はありません"
                      : "読み込んでいます…"}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className={`${ui.iconBtn} ${styles.saveIcon}`}
                aria-label="保存パネルを開く"
                title="保存パネルを開く"
                onClick={() => {
                  setSelected(UNSAVED);
                  openSave();
                }}
              >
                <SaveIcon />
              </button>
            </li>
            {history.commits.map((commit, index) => {
              const row = rows[index];
              if (!row) return null;
              const on = selected === commit.oid;
              return (
                <li key={commit.oid} className={styles.entry} data-selected={on || undefined}>
                  <button
                    type="button"
                    className={styles.entryBtn}
                    aria-pressed={on}
                    onClick={() => setSelected(commit.oid)}
                  >
                    <Graph
                      lane={row.lane}
                      incoming={row.incoming}
                      outgoing={row.outgoing}
                      forks={row.forks}
                      connectTop={index === 0}
                    />
                    <span className={styles.entryText}>
                      <span className={styles.entryTitle}>{subjectOf(commit)}</span>
                      <span className={styles.entryMeta}>
                        {commit.oid.slice(0, 7)} · {commit.author.name} ·{" "}
                        {when(commit.author.timestamp)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {history.error && <p className={ui.error}>{history.error}</p>}
        </div>
        <section className={styles.detail} aria-label="詳細">
          {selected === UNSAVED || !pickedCommit ? (
            <UnsavedDetail
              entries={history.entries}
              ready={history.ready}
              selected={pickedEntry?.id ?? null}
              onSelect={select}
            />
          ) : (
            <CommitDetail
              commit={pickedCommit}
              changes={diff}
              diffing={diffing}
              error={diffError}
              selected={pickedEntry?.id ?? null}
              onSelect={select}
            />
          )}
        </section>
        <ChangeSide entry={pickedEntry} />
      </div>
    </div>
  );
}

function UnsavedDetail({
  entries,
  ready,
  selected,
  onSelect,
}: {
  entries: DiffEntry[];
  ready: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <h3 className={styles.subject}>未保存</h3>
      <p className={ui.muted}>
        まだ履歴に残していない変更です。作業の内容は、サーバーに自動で残っています。残すときは、左の印か「保存」から。
      </p>
      <DiffBlock count={ready ? entries.length : null}>
        {ready ? (
          <ChangeList entries={entries} selected={selected} onSelect={onSelect} />
        ) : (
          <p className={ui.muted}>読み込んでいます…</p>
        )}
      </DiffBlock>
    </>
  );
}

function CommitDetail({
  commit,
  changes,
  diffing,
  error,
  selected,
  onSelect,
}: {
  commit: CommitInfo;
  changes: DiffEntry[];
  diffing: boolean;
  error: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [subject, ...rest] = commit.message.split("\n");
  const body = rest.join("\n").trim();
  return (
    <>
      <h3 className={styles.subject}>{subject}</h3>
      {body && <p className={styles.body}>{body}</p>}
      <dl className={styles.meta}>
        <div>
          <dt>書いた人</dt>
          <dd>{commit.author.name}</dd>
        </div>
        <div>
          <dt>とき</dt>
          <dd>{when(commit.author.timestamp)}</dd>
        </div>
        <div>
          <dt>番号</dt>
          <dd className={styles.oid} title={commit.oid}>
            {commit.oid.slice(0, 7)}
          </dd>
        </div>
      </dl>
      <DiffBlock count={diffing ? null : changes.length}>
        {error ? (
          <p className={ui.error}>{error}</p>
        ) : diffing ? (
          <p className={ui.muted}>読み込んでいます…</p>
        ) : (
          <ChangeList entries={changes} selected={selected} onSelect={onSelect} />
        )}
      </DiffBlock>
    </>
  );
}

function DiffBlock({ count, children }: { count: number | null; children: ReactNode }) {
  return (
    <div>
      <div className={styles.diffHead}>
        <h4 className={ui.sectionTitle}>差分</h4>
        {count !== null && <span className={count > 0 ? ui.badgeWarn : ui.badge}>{count}件</span>}
      </div>
      {children}
    </div>
  );
}

function Graph({
  lane,
  incoming,
  outgoing,
  forks,
  connectTop = false,
  hollow = false,
  mark,
}: {
  lane: number;
  incoming: boolean[];
  outgoing: boolean[];
  forks: number[];
  connectTop?: boolean;
  hollow?: boolean;
  mark?: string;
}) {
  const cols = Math.max(incoming.length, outgoing.length, lane + 1, 1);
  const width = cols * COL;
  const dotColor = mark ?? laneColor(lane);
  return (
    <div className={styles.graph} style={{ width }} aria-hidden="true">
      {Array.from({ length: cols }, (_, column) => {
        const node = column === lane;
        const above = Boolean(incoming[column]) || (node && connectTop);
        const below = Boolean(outgoing[column]);
        if (!above && !below && !node) return null;
        const x = column * COL + COL / 2;
        return (
          // 列の番号が、その線の位置そのもの
          // biome-ignore lint/suspicious/noArrayIndexKey: 列番号が線の位置
          <span key={column}>
            {(above || below) && (
              <span
                className={styles.vline}
                style={{
                  left: x,
                  top: above ? 0 : "50%",
                  bottom: below ? 0 : "50%",
                  background: laneColor(column),
                }}
              />
            )}
            {node &&
              (hollow ? (
                <span className={styles.dotHollow} style={{ left: x, borderColor: dotColor }} />
              ) : (
                <span className={styles.dot} style={{ left: x, background: dotColor }} />
              ))}
          </span>
        );
      })}
      {forks.length > 0 && (
        <svg
          className={styles.fork}
          viewBox={`0 0 ${width} 40`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {forks.map((fork) => {
            const x1 = lane * COL + COL / 2;
            const x2 = fork * COL + COL / 2;
            return (
              <path
                key={fork}
                d={`M ${x1} 20 C ${x1} 40, ${x2} 20, ${x2} 40`}
                stroke={laneColor(fork)}
                strokeWidth="2"
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M3 2.5h7.1L13 5.4V13.5H3V2.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M5.2 2.5V5.6h4.4V2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.2 13.5v-3.2h5.6v3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function emptySnapshot(): ProjectSnapshot {
  return {
    version: 1,
    name: "",
    kokostates: [],
    systems: [],
    materials: [],
    assets: [],
    outputs: [],
    entities: [],
  };
}

function subjectOf(commit: CommitInfo): string {
  return commit.message.split("\n")[0] || "（メッセージなし）";
}

function when(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
