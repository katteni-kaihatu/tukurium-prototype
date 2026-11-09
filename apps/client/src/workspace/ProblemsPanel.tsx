import type {
  Diagnostic,
  DiagnosticView,
  ProjectDoc,
  ResourcePathIndex,
  ResourceRef,
} from "@tukurium/repo-model";
import { useMemo, useState } from "react";
import { useProject } from "./hooks";
import { RUNTIME_PROVIDER, SCRIPT_PROVIDER, scriptLine } from "./problems";
import {
  DEFAULT_FILTER,
  filterProblems,
  folderOfPath,
  GROUP_LABEL,
  groupProblems,
  type ProblemContext,
  type ProblemFilter,
  type ProblemGroupBy,
  problemDetail,
} from "./problemsView";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useWorkspaceProblems } from "./useProblems";

/** 問題 1 件の場所の表示（「Shoot.js 4 行目」） */
export function problemPlace(name: string, p: Diagnostic): string {
  const line = scriptLine(p);
  return `${name}.js${line ? ` ${line} 行目` : ""}`;
}

const isScript = (d: Diagnostic) =>
  d.provider === SCRIPT_PROVIDER || d.provider === RUNTIME_PROVIDER;

/** 問題の種類の短い説明 */
export function problemKind(d: DiagnosticView): string {
  if (d.freshness === "stale") return d.phase === "runtime" ? "編集前の実行" : "編集前の確認";
  if (d.phase === "runtime") return "実行して停止";
  return d.severity === "warning" ? "注意" : "Play 前の確認";
}

/**
 * 問題パネル（ADR 0010）。スクリプトの問題（編集中の確認・実行して止まったもの）と、
 * 制作データの問題（構造・リソース参照）をまとめて出す。
 * 編集した後の古い結果は stale として薄く出し、件数には数えない。
 * メインパネルからはボタンで開く。新しいエラーが出たら自動で開く（useOpenProblemsOnError）。
 */
export function ProblemsPanel() {
  const project = useProject();
  const { items, count, index } = useWorkspaceProblems();
  const { select, setOutput, outputId, showProblem, openDetail, placeDetail } = useWorkspace();
  const [filter, setFilter] = useState<ProblemFilter>(DEFAULT_FILTER);
  const [groupBy, setGroupBy] = useState<ProblemGroupBy>("none");
  /** 「選んでいるアウトプットだけ」。アウトプットを選び直したら、その新しいアウトプットで絞る */
  const [onlyOutput, setOnlyOutput] = useState(false);
  /** 詳しく開いている問題（指紋） */
  const [opened, setOpened] = useState<string | null>(null);
  const checking = useWorkspace((s) => s.checking);
  const ctx = useMemo<ProblemContext>(
    () => ({
      placeOf: (d) =>
        isScript(d)
          ? problemPlace(project.system(d.subject.id)?.name ?? d.subject.id, d)
          : placeOf(d.subject, project, index),
      subjectOf: (d) =>
        isScript(d)
          ? (index?.pathOf(d.subject.id) ??
            `${project.system(d.subject.id)?.name ?? d.subject.id}.js`)
          : placeOf(d.subject, project, index),
      outputsOf: (d) => {
        const { kind, id } = d.subject;
        if (kind === "output") return [id];
        if (kind === "entity") {
          const out = project.entity(id)?.output;
          return out ? [out] : [];
        }
        if (kind === "system")
          return project
            .outputs()
            .filter((o) => o.systems.some((s) => s.id === id))
            .map((o) => o.id);
        return [];
      },
      folderOf: (d) => {
        const { kind, id } = d.subject;
        if (kind === "project" || kind === "entity" || kind === "output") return null;
        return folderOfPath(index?.pathOf(id) ?? null);
      },
      outputName: (id) => project.output(id)?.name ?? id,
      refName: (r) => placeOf(r, project, index),
    }),
    [project, index],
  );
  const groups = useMemo(
    () =>
      groupProblems(
        filterProblems(items, { ...filter, outputId: onlyOutput ? outputId : null }, ctx),
        groupBy,
        ctx,
      ),
    [items, filter, onlyOutput, outputId, groupBy, ctx],
  );
  const toggle = <T,>(list: readonly T[], values: readonly T[], on: boolean): T[] =>
    on ? [...new Set([...list, ...values])] : list.filter((v) => !values.includes(v));
  /** スクリプトはコードのその行へ。定義は詳細パネル、Entity は Inspector */
  const openDef = (el: EventTarget | null, kind: "koko" | "system" | "material", id: string) => {
    const mode =
      el instanceof Element && el.closest("[data-mode]")?.getAttribute("data-mode") === "3d"
        ? "3d"
        : "2d";
    placeDetail(mode);
    openDetail({ kind, id });
  };
  const target = (d: Diagnostic): ((e: { currentTarget: EventTarget | null }) => void) | null => {
    if (isScript(d)) return () => showProblem(d);
    const { kind, id } = d.subject;
    if (kind === "entity") {
      const e = project.entity(id);
      if (!e || !project.output(e.output)) return null;
      return () => {
        if (e.output !== outputId) setOutput(e.output);
        select({ kind: "entity", id });
      };
    }
    if (kind === "output")
      return () => {
        setOutput(id);
        select({ kind: "output", id });
      };
    if (kind === "kokostate") return (e) => openDef(e.currentTarget, "koko", id);
    if (kind === "system" || kind === "material") return (e) => openDef(e.currentTarget, kind, id);
    return null;
  };
  if (items.length === 0)
    return (
      <div className={ui.section}>
        <p className={ui.muted}>エラーはありません。</p>
      </div>
    );
  return (
    <section className={ui.section} aria-label="エラー">
      <div className={ui.sectionHead}>
        <h3 className={ui.sectionTitle}>エラー</h3>
        {count.errors + count.warnings > 0 ? (
          <span
            className={ui.badgeError}
            title={count.stale ? `ほかに編集前の結果が ${count.stale} 件` : undefined}
          >
            {count.errors + count.warnings}
          </span>
        ) : (
          // 編集した直後は数字を 0 にせず、編集前の結果の件数を薄く出す（点滅を避ける）
          <span
            className={ui.badgeError}
            data-fresh="stale"
            title="編集前の結果（確かめ直しています）"
          >
            {count.stale}
          </span>
        )}
        <button
          type="button"
          className={ui.btn}
          disabled={checking}
          title="すべての System を、もう一度確かめる"
          onClick={() => useWorkspace.setState((s) => ({ recheckSeq: s.recheckSeq + 1 }))}
        >
          {checking ? "確かめています…" : "確かめ直す"}
        </button>
      </div>
      <div className={ui.toolbar}>
        <input
          className={ui.input}
          type="search"
          placeholder="問題を探す"
          aria-label="問題を探す"
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
        />
        <select
          className={ui.select}
          aria-label="まとめ方"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as ProblemGroupBy)}
        >
          {(Object.keys(GROUP_LABEL) as ProblemGroupBy[]).map((k) => (
            <option key={k} value={k}>
              {GROUP_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <fieldset className={ui.filters} aria-label="絞り込み">
        <label>
          <input
            type="checkbox"
            checked={filter.severities.includes("error")}
            onChange={(e) =>
              setFilter({
                ...filter,
                severities: toggle(filter.severities, ["error"], e.target.checked),
              })
            }
          />
          エラー
        </label>
        <label>
          <input
            type="checkbox"
            checked={filter.severities.includes("warning")}
            onChange={(e) =>
              setFilter({
                ...filter,
                severities: toggle(filter.severities, ["warning", "info"], e.target.checked),
              })
            }
          />
          注意
        </label>
        <label>
          <input
            type="checkbox"
            checked={filter.phases.includes("authoring")}
            onChange={(e) =>
              setFilter({
                ...filter,
                phases: toggle(filter.phases, ["authoring"], e.target.checked),
              })
            }
          />
          作っている途中
        </label>
        <label>
          <input
            type="checkbox"
            checked={filter.phases.includes("runtime")}
            onChange={(e) =>
              setFilter({ ...filter, phases: toggle(filter.phases, ["runtime"], e.target.checked) })
            }
          />
          実行
        </label>
        <label>
          <input
            type="checkbox"
            checked={filter.showStale}
            onChange={(e) => setFilter({ ...filter, showStale: e.target.checked })}
          />
          編集前の結果
        </label>
        <label>
          <input
            type="checkbox"
            checked={onlyOutput}
            disabled={!outputId}
            onChange={(e) => setOnlyOutput(e.target.checked)}
          />
          選んでいるアウトプットだけ
        </label>
      </fieldset>
      {groups.length === 0 && <p className={ui.muted}>条件に合う問題はありません。</p>}
      {groups.map((g) => (
        <div key={g.key}>
          {g.label && (
            <h4 className={ui.groupHead}>
              {g.label} · {g.items.length}
            </h4>
          )}
          <ul className={ui.list} aria-label={g.label || "問題"}>
            {g.items.map((d) => {
              const go = target(d);
              const body = (
                <>
                  <span className={ui.problemPlace}>
                    {ctx.placeOf(d)}
                    <span className={ui.problemKind}>{problemKind(d)}</span>
                  </span>
                  <span>{d.message}</span>
                </>
              );
              const attrs = {
                className: ui.problem,
                "data-tone": d.severity,
                "data-fresh": d.freshness,
              };
              const open = opened === d.fingerprint;
              return (
                <li key={`${d.freshness}:${d.id}`}>
                  <div className={ui.problemRow}>
                    {go ? (
                      <button
                        type="button"
                        {...attrs}
                        title={
                          isScript(d)
                            ? "コードを開く"
                            : d.subject.kind === "kokostate" ||
                                d.subject.kind === "system" ||
                                d.subject.kind === "material"
                              ? "詳細パネルで開く"
                              : (d.detail ?? "Inspector で選ぶ")
                        }
                        onClick={go}
                      >
                        {body}
                      </button>
                    ) : (
                      <div {...attrs} title={d.detail}>
                        {body}
                      </div>
                    )}
                    <button
                      type="button"
                      className={ui.iconBtn}
                      aria-expanded={open}
                      aria-label={open ? "詳しくを閉じる" : "詳しく"}
                      title={open ? "詳しくを閉じる" : "詳しく"}
                      onClick={() => setOpened(open ? null : d.fingerprint)}
                    >
                      {open ? "▾" : "▸"}
                    </button>
                  </div>
                  {open && (
                    <dl className={ui.problemDetail}>
                      {problemDetail(d, ctx).map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** 問題の対象の場所（リソースは論理パス、Entity・アウトプットは名前） */
function placeOf(ref: ResourceRef, project: ProjectDoc, index: ResourcePathIndex | null): string {
  const { kind, id } = ref;
  if (kind === "project") return "/（いちばん上）";
  if (kind === "entity") return `Entity「${project.entity(id)?.name ?? id}」`;
  if (kind === "output") return `アウトプット「${project.output(id)?.name ?? id}」`;
  return index?.pathOf(id) ?? id;
}
