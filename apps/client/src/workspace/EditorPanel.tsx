import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter } from "@codemirror/view";
import { type ProjectDoc, systemCodePath, typeCodePath } from "@tukurium/repo-model";
import { hostApiCompletions } from "@tukurium/runtime";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { yCollab } from "y-codemirror.next";
import { installFlatEditorCoords } from "../panels/editorCoords";
import { type LineChanges, lineChanges } from "./diffView";
import { useProject } from "./hooks";
import { type ImportCandidate, importCandidates, importCompletionSource } from "./importCompletion";
import { problemKind, problemPlace } from "./ProblemsPanel";
import { scriptLine } from "./problems";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useProblems } from "./useProblems";
import { useSavedFiles } from "./useSavedFiles";

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
                {codeFileName(project, id)}
                {allProblems.some((p) => p.subject.id === id && p.freshness === "current") && (
                  <span className={ui.badgeError} style={{ marginLeft: 6 }}>
                    !
                  </span>
                )}
              </button>
              <button
                type="button"
                className={ui.iconBtn}
                aria-label={`${codeName(project, id)} を閉じる`}
                onClick={() => closeSystem(id)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <p className={ui.muted}>
          {mode === "edit"
            ? "変更は次の Play から反映されます。"
            : "Play 中の変更は、Stop して Play し直すと反映されます。"}
        </p>
      </div>
      {activeSystem && <CodeView key={activeSystem} systemId={activeSystem} />}
      {/* エラーはコードの下に出す（上に出すと、出るたびにコードの位置がずれる） */}
      {problems.length > 0 && (
        <section
          aria-label="このコードの問題"
          className={ui.section}
          style={{
            flex: "none",
            maxHeight: 132,
            overflow: "auto",
            paddingTop: 6,
            paddingBottom: 8,
          }}
        >
          {problems.map((p) => (
            <button
              key={`${p.freshness}:${p.id}`}
              type="button"
              className={ui.problem}
              data-fresh={p.freshness}
              onClick={() => showProblem(p)}
            >
              <span className={ui.problemPlace}>
                {problemPlace(codeName(project, p.subject.id), p)}
                <span className={ui.problemKind}>{problemKind(p)}</span>
              </span>
              <span>{p.message}</span>
            </button>
          ))}
        </section>
      )}
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

// ---------------------------------------------------------------------------
// 最後の保存からの変化（VSCode の溝の印のように）：足した行は緑、書き換えた行は黄色の線、
// 行を消したところは赤の ▶。保存した内容がまだ読めていないときは出さない

const NO_CHANGES: LineChanges = { added: new Set(), modified: new Set(), deletedAfter: new Set() };
const setLineChanges = StateEffect.define<LineChanges>();
const lineChangesField = StateField.define<LineChanges>({
  create: () => NO_CHANGES,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLineChanges)) return e.value;
    return value;
  },
});

class ChangeMarker extends GutterMarker {
  constructor(
    readonly kind: "added" | "modified" | null,
    /** この行の下（top は上）で行を消した */
    readonly deleted: "below" | "top" | null,
  ) {
    super();
  }
  override eq(other: ChangeMarker): boolean {
    return other.kind === this.kind && other.deleted === this.deleted;
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = "cm-tk-change";
    if (this.kind) el.dataset.kind = this.kind;
    if (this.deleted) el.dataset.deleted = this.deleted;
    el.title = [
      this.kind === "added" ? "足した行" : this.kind === "modified" ? "書き換えた行" : null,
      this.deleted ? "ここで行を消した" : null,
    ]
      .filter(Boolean)
      .join("・");
    return el;
  }
}

const changeMarkers = new Map<string, ChangeMarker>();
function changeMarker(kind: ChangeMarker["kind"], deleted: ChangeMarker["deleted"]): ChangeMarker {
  const key = `${kind}:${deleted}`;
  let m = changeMarkers.get(key);
  if (!m) {
    m = new ChangeMarker(kind, deleted);
    changeMarkers.set(key, m);
  }
  return m;
}

const lineChangeGutter = gutter({
  class: "cm-tk-changes",
  lineMarker(view, line) {
    const n = view.state.doc.lineAt(line.from).number;
    const c = view.state.field(lineChangesField);
    const kind = c.added.has(n) ? "added" : c.modified.has(n) ? "modified" : null;
    const deleted = c.deletedAfter.has(n)
      ? "below"
      : n === 1 && c.deletedAfter.has(0)
        ? "top"
        : null;
    return kind || deleted ? changeMarker(kind, deleted) : null;
  },
  lineMarkerChange: (update) =>
    update.transactions.some((tr) => tr.effects.some((e) => e.is(setLineChanges))),
});

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

/** エディタで開くコード（System か、型の定義）の名前 */
function codeName(project: ProjectDoc, id: string): string {
  return project.system(id)?.name ?? project.typeDef(id)?.name ?? id;
}

/** タブに出すファイルの名前（System は .ts、型の定義は .d.ts） */
function codeFileName(project: ProjectDoc, id: string): string {
  return `${codeName(project, id)}${project.typeDef(id) ? ".d.ts" : ".ts"}`;
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
  // 最後に保存したこのスクリプトのコード（新しく作ったものは空）。読めていない間は null
  const saved = useSavedFiles();
  // 型の定義（ADR 0065）も、同じエディタで開く。保存したファイルの場所だけが違う
  const savedPath = project.typeDef(systemId) ? typeCodePath(systemId) : systemCodePath(systemId);
  const savedCode = saved ? (saved[savedPath] ?? "") : null;
  const savedRef = useRef(savedCode);
  savedRef.current = savedCode;
  const refreshChanges = useRef<() => void>(() => {});
  const role = useWorkspace((s) => s.role);
  const readOnly = role === "viewer";

  useEffect(() => {
    const text = project.code(systemId);
    if (!host.current || !text) return;
    // import の候補。制作データか依存が変わったときだけ作り直す
    let cache: { rev: number; packages: unknown; list: ImportCandidate[] } | null = null;
    const candidates = () => {
      const { rev, packages } = useWorkspace.getState();
      if (!cache || cache.rev !== rev || cache.packages !== packages) {
        cache = { rev, packages, list: importCandidates(project.snapshot(), systemId, packages) };
      }
      return cache.list;
    };
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          basicSetup,
          javascript({ typescript: true }),
          javascriptLanguage.data.of({ autocomplete: hostApiCompletionSource }),
          javascriptLanguage.data.of({ autocomplete: importCompletionSource(candidates) }),
          // カーソル・選択の共有（awareness は閲覧権限のある人にだけ中継される）
          yCollab(text, awareness),
          EditorState.readOnly.of(readOnly),
          marks.current.of([]),
          lineChangesField,
          lineChangeGutter,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) refreshChanges.current();
          }),
          EditorView.theme({
            "&": { fontSize: "12.5px", height: "100%" },
            ".cm-scroller": { fontFamily: "var(--font-mono)" },
            ".cm-gutters": { background: "#f6f2ec", border: "none" },
            ".cm-tk-errorLine": { background: "#f6e3e3", boxShadow: "inset 3px 0 #b23b3b" },
            ".cm-tk-changes .cm-gutterElement": {
              width: "5px",
              padding: "0",
              position: "relative",
            },
            ".cm-tk-change": { position: "absolute", inset: "0" },
            ".cm-tk-change[data-kind='added']": { background: "#3f9b5f" },
            ".cm-tk-change[data-kind='modified']": { background: "#d9a521" },
            ".cm-tk-change[data-deleted]::after": {
              content: "''",
              position: "absolute",
              left: "0",
              width: "0",
              height: "0",
              borderTop: "4px solid transparent",
              borderBottom: "4px solid transparent",
              borderLeft: "6px solid #c23b3b",
            },
            ".cm-tk-change[data-deleted='below']::after": { bottom: "-4px" },
            ".cm-tk-change[data-deleted='top']::after": { top: "-4px" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    // 書くたびに比べ直すと重いので、手が止まってから比べる
    let timer: ReturnType<typeof setTimeout> | null = null;
    const compute = () => {
      const before = savedRef.current;
      const value = before === null ? NO_CHANGES : lineChanges(before, view.state.doc.toString());
      view.dispatch({ effects: setLineChanges.of(value) });
    };
    refreshChanges.current = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(compute, 150);
    };
    compute();
    return () => {
      if (timer) clearTimeout(timer);
      refreshChanges.current = () => {};
      viewRef.current = null;
      view.destroy();
    };
  }, [project, systemId, awareness, readOnly]);

  // 保存し直した・保存した内容を読めたときも比べ直す
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedCode は比べ直すきっかけ
  useEffect(() => {
    refreshChanges.current();
  }, [savedCode]);

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
