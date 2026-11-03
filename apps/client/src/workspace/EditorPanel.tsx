import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { Compartment, EditorSelection, EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { hostApiCompletions } from "@tukurium/runtime";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { yCollab } from "y-codemirror.next";
import { installFlatEditorCoords } from "../panels/editorCoords";
import { useProject } from "./hooks";
import { problemKind, problemPlace } from "./ProblemsPanel";
import { scriptLine } from "./problems";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useProblems } from "./useProblems";

installFlatEditorCoords();

/**
 * System のコードエディタ。CodeMirror を制作データの Y.Text に結びつける
 * （M2 でそのまま共同編集・カーソル共有になる）。
 */
export function EditorPanel() {
  const { openSystems, activeSystem, openSystem, closeSystem, mode, showProblem } = useWorkspace();
  const project = useProject();
  useWorkspace((s) => s.rev);
  const allProblems = useProblems();
  const problems = allProblems.filter((p) => p.subject.id === activeSystem);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" }}
    >
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
                {allProblems.some((p) => p.subject.id === id && p.freshness === "current") && (
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
                key={`${p.freshness}:${p.id}`}
                type="button"
                className={ui.problem}
                data-fresh={p.freshness}
                onClick={() => showProblem(p)}
              >
                <span className={ui.problemPlace}>
                  {problemPlace(project.system(p.subject.id)?.name ?? "", p)}
                  <span className={ui.problemKind}>{problemKind(p)}</span>
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

/**
 * Host API の入力補完：`world.` `audio.` などのあとに、使える関数と説明・要る権限を出す。
 * `hit.` は Raycast の結果のメソッド。候補は runtime の HOST_API_SPEC から作る（一つの定義）
 */
function hostApiCompletionSource(context: CompletionContext): CompletionResult | null {
  const m = context.matchBefore(/\b(world|time|audio|contract|effects|hit)\.\w*$/);
  if (!m) return null;
  const dot = m.text.indexOf(".");
  const options = hostApiCompletions(m.text.slice(0, dot));
  if (options.length === 0) return null;
  return { from: m.from + dot + 1, options, validFor: /^\w*$/ };
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
    .map((p) => (p.subject.id === systemId ? scriptLine(p) : null))
    .filter((n): n is number => n !== null);
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
          javascriptLanguage.data.of({ autocomplete: hostApiCompletionSource }),
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
        flex: "1 1 auto",
        height: 420,
        minHeight: 160,
        overflow: "hidden",
        borderTop: "1px solid rgba(38,38,46,.08)",
        background: "#fff",
      }}
    />
  );
}
