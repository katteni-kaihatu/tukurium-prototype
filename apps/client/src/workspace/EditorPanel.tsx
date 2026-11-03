import { javascript } from "@codemirror/lang-javascript";
import { Compartment, EditorSelection, EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { yCollab } from "y-codemirror.next";
import { useProject } from "./hooks";
import { problemPlace } from "./ProblemsList";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useProblems } from "./useProblems";

/**
 * System のコードエディタ。CodeMirror を制作データの Y.Text に結びつける
 * （M2 でそのまま共同編集・カーソル共有になる）。
 */
export function EditorPanel() {
  const { openSystems, activeSystem, openSystem, closeSystem, mode, showProblem } = useWorkspace();
  const project = useProject();
  useWorkspace((s) => s.rev);
  const allProblems = useProblems();
  const problems = allProblems.filter((p) => p.systemId === activeSystem);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className={ui.section} style={{ paddingTop: 6, paddingBottom: 6 }}>
        <div className={ui.tabs} role="tablist" aria-label="開いているコード">
          {openSystems.map((id) => (
            <span key={id} style={{ display: "inline-flex", alignItems: "center" }}>
              <button
                type="button"
                role="tab"
                className={ui.tab}
                aria-selected={activeSystem === id}
                onClick={() => openSystem(id)}
              >
                {project.system(id)?.name ?? id}.js
                {allProblems.some((p) => p.systemId === id) && (
                  <span className={ui.badgeError} style={{ marginLeft: 6 }}>
                    !
                  </span>
                )}
              </button>
              <button
                type="button"
                className={ui.iconBtn}
                aria-label={`${project.system(id)?.name ?? id} を閉じる`}
                onClick={() => closeSystem(id)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        {problems.length > 0 && (
          <section aria-label="このコードの問題">
            {problems.map((p) => (
              <button
                key={`${p.source}:${p.message}`}
                type="button"
                className={ui.problem}
                onClick={() => showProblem(p)}
              >
                <span className={ui.problemPlace}>
                  {problemPlace(project.system(p.systemId)?.name ?? "", p)}
                </span>
                <span>{p.message}</span>
              </button>
            ))}
          </section>
        )}
        <p className={ui.muted}>
          {mode === "edit"
            ? "変更は次の Play から反映されます。"
            : "Play 中の変更は、Stop して Play し直すと反映されます。"}
        </p>
      </div>
      {activeSystem && <CodeView key={activeSystem} systemId={activeSystem} />}
    </div>
  );
}

const errorLine = Decoration.line({ class: "cm-tk-errorLine" });

/** 問題のある行に印を付ける（編集で行がずれても、いまの行番号で付け直す） */
function errorLines(lines: number[]) {
  const sorted = [...new Set(lines)].sort((x, y) => x - y);
  return EditorView.decorations.of((view) => {
    const b = new RangeSetBuilder<Decoration>();
    for (const n of sorted) {
      if (n >= 1 && n <= view.state.doc.lines) {
        const at = view.state.doc.line(n).from;
        b.add(at, at, errorLine);
      }
    }
    return b.finish();
  });
}

function CodeView({ systemId }: { systemId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const marks = useRef(new Compartment());
  const lines = useProblems()
    .filter((p) => p.systemId === systemId && p.line)
    .map((p) => p.line as number);
  const linesKey = lines.join(",");
  const jumpTo = useWorkspace((s) => s.jumpTo);
  const project = useProject();
  const awareness = useWorkspace((s) => s.awareness);
  const role = useWorkspace((s) => s.role);
  const readOnly = role === "viewer";

  useEffect(() => {
    const text = project.code(systemId);
    if (!host.current || !text) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          basicSetup,
          javascript(),
          // カーソル・選択の共有（awareness は閲覧権限のある人にだけ中継される）
          yCollab(text, awareness),
          EditorState.readOnly.of(readOnly),
          marks.current.of([]),
          EditorView.theme({
            "&": { fontSize: "12.5px", height: "100%" },
            ".cm-scroller": { fontFamily: "var(--font-mono)" },
            ".cm-gutters": { background: "#f6f2ec", border: "none" },
            ".cm-tk-errorLine": { background: "#f6e3e3", boxShadow: "inset 3px 0 #b23b3b" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [project, systemId, awareness, readOnly]);

  // 問題のある行の印
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const ls = linesKey ? linesKey.split(",").map(Number) : [];
    view.dispatch({ effects: marks.current.reconfigure(errorLines(ls)) });
  }, [linesKey]);

  // 「問題」から開いたとき、その行へ移る
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jumpTo || jumpTo.systemId !== systemId || !jumpTo.line) return;
    const n = Math.min(jumpTo.line, view.state.doc.lines);
    const line = view.state.doc.line(n);
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }, [jumpTo, systemId]);

  return (
    <div
      ref={host}
      style={{
        height: 420,
        overflow: "hidden",
        borderTop: "1px solid rgba(38,38,46,.08)",
        background: "#fff",
      }}
    />
  );
}
