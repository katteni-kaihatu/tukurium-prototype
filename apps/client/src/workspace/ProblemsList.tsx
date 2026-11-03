import { useProject } from "./hooks";
import type { Problem } from "./problems";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useProblems, useStructureDiagnostics } from "./useProblems";

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
  const { diagnostics, index } = useStructureDiagnostics();
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
        {diagnostics.map((d) => (
          <li key={d.id}>
            <div className={ui.problem} title={d.detail}>
              <span className={ui.problemPlace}>
                {d.subject.kind === "project"
                  ? "/（いちばん上）"
                  : (index?.pathOf(d.subject.id) ?? d.subject.id)}
                <span className={ui.problemKind}>
                  {d.severity === "warning" ? "注意" : "Play 前の確認"}
                </span>
              </span>
              <span>{d.message}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
