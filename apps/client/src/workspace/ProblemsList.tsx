import type { Diagnostic, ProjectDoc, ResourcePathIndex } from "@tukurium/repo-model";
import { useProject } from "./hooks";
import type { Problem } from "./problems";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useProblems, useProjectDiagnostics } from "./useProblems";

/** 問題 1 件の場所の表示（「Shoot.js 4 行目」） */
export function problemPlace(name: string, p: Problem): string {
  return `${name}.js${p.line ? ` ${p.line} 行目` : ""}`;
}

/**
 * スクリプトの問題の一覧。編集中の確認（構文など）と、実行して止まった System をまとめて出す。
 * クリックするとコードを開いて、その行へ移る。
 */
export function ProblemsList() {
  const problems = useProblems();
  const project = useProject();
  const showProblem = useWorkspace((s) => s.showProblem);
  const { diagnostics, index } = useProjectDiagnostics();
  const { select, setOutput, outputId } = useWorkspace();
  /** 問題の対象を Inspector で選ぶ（選べるものだけ） */
  const target = (d: Diagnostic): (() => void) | null => {
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
    if (kind === "kokostate") return () => select({ kind: "koko", id });
    if (kind === "system" || kind === "material") return () => select({ kind, id });
    return null;
  };
  const count = problems.length + diagnostics.length;
  if (count === 0) return null;
  return (
    <section className={ui.section} aria-label="問題">
      <div className={ui.sectionHead}>
        <h3 className={ui.sectionTitle}>問題</h3>
        <span className={ui.badgeError}>{count}</span>
      </div>
      <ul className={ui.list}>
        {problems.map((p) => (
          <li key={`${p.source}:${p.systemId}:${p.message}`}>
            <button
              type="button"
              className={ui.problem}
              title="コードを開く"
              onClick={() => showProblem(p)}
            >
              <span className={ui.problemPlace}>
                {problemPlace(project.system(p.systemId)?.name ?? p.systemId, p)}
                <span className={ui.problemKind}>
                  {p.source === "run" ? "実行して停止" : "Play 前の確認"}
                </span>
              </span>
              <span>{p.message}</span>
            </button>
          </li>
        ))}
        {diagnostics.map((d) => {
          const go = target(d);
          const body = (
            <>
              <span className={ui.problemPlace}>
                {placeOf(d, project, index)}
                <span className={ui.problemKind}>
                  {d.severity === "warning" ? "注意" : "Play 前の確認"}
                </span>
              </span>
              <span>{d.message}</span>
            </>
          );
          return (
            <li key={d.id}>
              {go ? (
                <button
                  type="button"
                  className={ui.problem}
                  data-tone={d.severity}
                  title={d.detail ?? "Inspector で選ぶ"}
                  onClick={go}
                >
                  {body}
                </button>
              ) : (
                <div className={ui.problem} data-tone={d.severity} title={d.detail}>
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
