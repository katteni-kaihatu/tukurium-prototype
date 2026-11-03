import {
  countCurrent,
  type Diagnostic,
  type DiagnosticView,
  type ProjectDoc,
  type ResourcePathIndex,
} from "@tukurium/repo-model";
import { useProject } from "./hooks";
import { RUNTIME_PROVIDER, SCRIPT_PROVIDER, scriptLine } from "./problems";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useProblems, useProjectDiagnostics } from "./useProblems";

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
 * 問題の一覧（ADR 0010）。スクリプトの問題（編集中の確認・実行して止まったもの）と、
 * 制作データの問題（構造・リソース参照）をまとめて出す。
 * 編集した後の古い結果は stale として薄く出し、件数には数えない。
 */
export function ProblemsList() {
  const problems = useProblems();
  const project = useProject();
  const { diagnostics, index } = useProjectDiagnostics();
  const { select, setOutput, outputId, showProblem, openDetail, placeDetail } = useWorkspace();
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
  // 制作データの問題は、いまの制作データからその場で計算するので、いつも current
  const items: DiagnosticView[] = [
    ...problems,
    ...diagnostics.map((d) => ({ ...d, freshness: "current" as const })),
  ];
  if (items.length === 0) return null;
  const count = countCurrent(items);
  return (
    <section className={ui.section} aria-label="問題">
      <div className={ui.sectionHead}>
        <h3 className={ui.sectionTitle}>問題</h3>
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
      </div>
      <ul className={ui.list}>
        {items.map((d) => {
          const go = target(d);
          const body = (
            <>
              <span className={ui.problemPlace}>
                {isScript(d)
                  ? problemPlace(project.system(d.subject.id)?.name ?? d.subject.id, d)
                  : placeOf(d, project, index)}
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
          return (
            <li key={`${d.freshness}:${d.id}`}>
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
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 問題の対象の場所（リソースは論理パス、Entity・アウトプットは名前） */
function placeOf(d: Diagnostic, project: ProjectDoc, index: ResourcePathIndex | null): string {
  const { kind, id } = d.subject;
  if (kind === "project") return "/（いちばん上）";
  if (kind === "entity") return `Entity「${project.entity(id)?.name ?? id}」`;
  if (kind === "output") return `アウトプット「${project.output(id)?.name ?? id}」`;
  return index?.pathOf(id) ?? id;
}
