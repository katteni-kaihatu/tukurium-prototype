import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import {
  closeHoverTooltips,
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  tooltips,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type {
  EditorDefinition,
  EditorDocumentation,
  EditorQuery,
  EditorResults,
} from "@tukurium/typecheck";
import { debugHoverValue } from "./debugValues";
import {
  autoImportCompletion,
  type ImportCandidate,
  importCompletionSource,
} from "./importCompletion";
import { useWorkspace } from "./store";
import { editorTypecheck } from "./typecheckClient";

/** 別の編集者による変更も含め、問い合わせ時の本文と制作データの版が一致する間だけ使う。 */
export async function queryEditor<K extends EditorQuery["kind"]>(
  view: EditorView,
  fileId: string,
  query: Omit<Extract<EditorQuery, { kind: K }>, "fileId" | "code"> & { kind: K },
): Promise<EditorResults[K] | null> {
  const { project, rev } = useWorkspace.getState();
  const doc = view.state.doc;
  const client = editorTypecheck;
  if (!client || !project) return null;
  const result = await client.query<K>(
    { ...query, fileId, code: doc.toString() } as Extract<EditorQuery, { kind: K }>,
    rev,
  );
  const current = useWorkspace.getState();
  return view.dom.isConnected &&
    view.state.doc === doc &&
    current.project === project &&
    current.rev === rev
    ? result
    : null;
}

// `@deprecated` の付いたもの（静的に危ない Host API など）を使っている所に、打ち消し線を引く（ADR 0082）。
// 理由は、コードホバーの説明に出る。問題の一覧には出さない
const deprecatedMark = Decoration.mark({ class: "cm-tk-deprecated" });
const setDeprecated = StateEffect.define<{ from: number; to: number }[]>();
const deprecatedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects)
      if (e.is(setDeprecated))
        return Decoration.set(
          e.value
            .filter((r) => r.from < r.to && r.to <= tr.state.doc.length)
            .map((r) => deprecatedMark.range(r.from, r.to)),
          true,
        );
    // 打っている間は、前の印を文字に合わせてずらしておく（次の問い合わせで引き直す）
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function deprecatedMarks(fileId: string) {
  return [
    deprecatedField,
    ViewPlugin.fromClass(
      class {
        private timer: ReturnType<typeof setTimeout> | null = null;
        private alive = true;
        constructor(private readonly view: EditorView) {
          this.schedule(0);
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.focusChanged) this.schedule(400);
        }
        destroy() {
          this.alive = false;
          if (this.timer !== null) clearTimeout(this.timer);
        }
        private schedule(delay: number) {
          if (this.timer !== null) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            this.timer = null;
            void queryEditor(this.view, fileId, { kind: "deprecated", position: 0 }).then(
              (ranges) => {
                if (this.alive && ranges) this.view.dispatch({ effects: setDeprecated.of(ranges) });
              },
            );
          }, delay);
        }
      },
    ),
  ];
}

export function openEditorDefinition(target: EditorDefinition): void {
  const state = useWorkspace.getState();
  if (target.kind === "koko") {
    state.openDetail({ kind: "koko", id: target.id });
  } else if (target.kind === "prefab") {
    // プレハブは、詳細を出して、中身を開く（Play mode 中は開けないので、詳細だけ）
    state.openDetail({ kind: "prefab", id: target.id });
    if (state.mode === "edit") state.openPrefab(target.id);
  } else {
    state.openSystem(target.id);
    useWorkspace.setState({
      jumpTo: {
        systemId: target.id,
        line: target.line,
        position: target.position,
        seq: (state.jumpTo?.seq ?? 0) + 1,
      },
    });
  }
}

/** 説明は HTML として解釈しない。JSDoc に書かれた文字をそのまま出す。 */
function renderDocumentation(dom: HTMLElement, info: EditorDocumentation): void {
  dom.replaceChildren();
  if (info.display) {
    const signature = document.createElement("pre");
    signature.textContent = info.display;
    dom.append(signature);
  }
  if (info.documentation) {
    const text = document.createElement("div");
    text.textContent = info.documentation;
    dom.append(text);
  }
}

const completionType = (kind: string) =>
  (
    ({
      method: "method",
      function: "function",
      property: "property",
      "member variable": "property",
      const: "constant",
      let: "variable",
      var: "variable",
      interface: "interface",
      class: "class",
      keyword: "keyword",
    }) as Record<string, string>
  )[kind] ?? "variable";

/**
 * 入力の候補：import のパスと import 文は自前の候補を単独で返し、本文では
 * TypeScript の候補に、まだ import していないものの自動 import の候補を合成する。
 */
export function editorCompletionSource(
  fileId: string,
  candidates: () => ImportCandidate[],
  getView: () => EditorView,
): CompletionSource {
  const own = importCompletionSource(candidates);
  return async (context: CompletionContext) => {
    const first = own(context);
    if (first) return first;
    const node = syntaxTree(context.state).resolveInner(context.pos, -1);
    if (["String", "LineComment", "BlockComment", "TemplateString"].includes(node.name))
      return null;
    const word = context.matchBefore(/[\w$]*$/);
    if (
      !context.explicit &&
      !word?.text &&
      context.state.sliceDoc(context.pos - 1, context.pos) !== "."
    )
      return null;
    const view = getView();
    const doc = context.state.doc;
    const auto = autoImportCompletion(context, candidates);
    const entries = await queryEditor(view, fileId, {
      kind: "completions",
      position: context.pos,
    });
    if (context.aborted || view.state.doc !== doc) return null;
    if (!entries) {
      // TypeScript の答えが無い（Worker の準備前など）ときも、自動 import の候補だけは出す
      return auto ? { from: auto.from, options: auto.options } : null;
    }
    const options: Completion[] = entries.map((entry) => ({
      label: entry.name,
      type: completionType(entry.kind),
      apply: entry.insertText ?? entry.name,
      info: async () => {
        const dom = document.createElement("div");
        dom.className = "cm-tk-documentation";
        const info = await queryEditor(view, fileId, {
          kind: "details",
          position: context.pos,
          name: entry.name,
          ...(entry.source ? { source: entry.source } : {}),
        });
        if (info && view.state.doc === doc) renderDocumentation(dom, info);
        return dom;
      },
    }));
    if (!auto) return { from: word?.from ?? context.pos, options };
    // 同じ名前は TypeScript の候補を残す（自動 import は、まだ import していないものの分だけ）
    const known = new Set(options.map((o) => o.label));
    const extra = auto.options.filter((o) => !known.has(o.label));
    if (extra.length === 0) return { from: word?.from ?? context.pos, options };
    return { from: auto.from, options: [...options, ...extra] };
  };
}

export function editorIntelligence(
  fileId: string,
  candidates: () => ImportCandidate[],
  getView: () => EditorView,
) {
  return [
    autocompletion({ override: [editorCompletionSource(fileId, candidates, getView)] }),
    tooltips({
      position: "absolute",
      tooltipSpace: (view) =>
        view.dom.closest("[data-mode='3d']")
          ? view.dom.getBoundingClientRect()
          : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
    }),
    hoverTooltip(
      (view, position) => {
        const word = view.state.wordAt(position);
        if (!word) return null;
        return {
          pos: word.from,
          end: word.to,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className = "cm-tk-documentation";
            dom.textContent = "読み込み中…";
            const state = useWorkspace.getState();
            const node = syntaxTree(view.state).resolveInner(position, -1);
            const before = view.state.sliceDoc(view.state.doc.lineAt(word.from).from, word.from);
            const value =
              !/String|Comment/.test(node.name) && !/\.\s*$/.test(before)
                ? debugHoverValue(
                    state.debugStop,
                    state.debugFrameId,
                    fileId,
                    view.state.sliceDoc(word.from, word.to),
                  )
                : null;
            const appendValue = () => {
              if (value === null) return;
              const current = document.createElement("pre");
              current.textContent = `現在の値\n${value}`;
              dom.append(current);
            };
            appendValue();
            let alive = true;
            void queryEditor(view, fileId, { kind: "hover", position }).then((info) => {
              if (!alive) return;
              dom.replaceChildren();
              if (!info) {
                if (value !== null) {
                  appendValue();
                  return;
                }
                view.dispatch({ effects: closeHoverTooltips });
                return;
              }
              renderDocumentation(dom, info);
              appendValue();
              for (const message of info.diagnostics) {
                const error = document.createElement("p");
                error.className = "cm-tk-diagnostic";
                error.textContent = message;
                dom.append(error);
              }
              if (info.definition) {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = "定義へ移動";
                const target = info.definition;
                button.onclick = () => openEditorDefinition(target);
                dom.append(button);
              }
              view.requestMeasure();
            });
            return {
              dom,
              destroy() {
                alive = false;
              },
            };
          },
        };
      },
      { hoverTime: 300, hideOnChange: true },
    ),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const mac = /Mac|iPhone|iPad/.test(navigator.platform);
        if (event.button !== 0 || !(mac ? event.metaKey : event.ctrlKey)) return false;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        void queryEditor(view, fileId, { kind: "definition", position }).then((target) => {
          if (target) openEditorDefinition(target);
        });
        return true;
      },
    }),
    deprecatedMarks(fileId),
    EditorView.theme({
      ".cm-tk-deprecated": { textDecoration: "line-through", textDecorationColor: "#8a8792" },
      ".cm-tk-documentation": {
        maxWidth: "420px",
        maxHeight: "260px",
        overflow: "auto",
        padding: "9px 12px",
        whiteSpace: "pre-wrap",
        fontSize: "12px",
        lineHeight: "1.5",
      },
      ".cm-tk-documentation pre": {
        margin: "0 0 6px",
        whiteSpace: "pre-wrap",
        fontFamily: "var(--font-mono)",
      },
      ".cm-tk-documentation button": { marginTop: "8px", cursor: "pointer" },
      ".cm-tk-diagnostic": { color: "#a22f2f", borderTop: "1px solid #e4caca", paddingTop: "6px" },
    }),
  ];
}
