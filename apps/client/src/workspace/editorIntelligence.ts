import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { closeHoverTooltips, EditorView, hoverTooltip, tooltips } from "@codemirror/view";
import type {
  EditorDefinition,
  EditorDocumentation,
  EditorQuery,
  EditorResults,
} from "@tukurium/typecheck";
import { debugHoverValue } from "./debugValues";
import { type ImportCandidate, importCompletionSource } from "./importCompletion";
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

export function openEditorDefinition(target: EditorDefinition): void {
  const state = useWorkspace.getState();
  if (target.kind === "koko") {
    state.openDetail({ kind: "koko", id: target.id });
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

export function editorIntelligence(
  fileId: string,
  candidates: () => ImportCandidate[],
  getView: () => EditorView,
) {
  const paths = importCompletionSource(candidates);
  const complete = async (context: CompletionContext) => {
    const path = paths(context);
    if (path) return path;
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
    const options = await queryEditor(view, fileId, { kind: "completions", position: context.pos });
    if (!options || context.aborted || view.state.doc !== doc) return null;
    return {
      from: word?.from ?? context.pos,
      options: options.map(
        (entry): Completion => ({
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
        }),
      ),
    };
  };
  return [
    autocompletion({ override: [complete] }),
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
    EditorView.theme({
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
