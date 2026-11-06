import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  BUILTIN_KOKOSTATES,
  type PackageResolution,
  type ProjectSnapshot,
  ResourcePathIndex,
} from "@tukurium/repo-model";

/** import できる KokoState ひとつ */
export interface ImportCandidate {
  /** KokoState の名前（import のローカル名にそのまま使う） */
  name: string;
  /** `from` に書くパス */
  spelling: string;
  /** どこのものか（このプロジェクト・Built-in・@別名） */
  source: string;
}

/**
 * このスクリプトから import できる KokoState。
 * プロジェクトのものはスクリプトの場所からの相対パス、Built-in は `@builtin/`、ライブラリは `@別名/`。
 */
export function importCandidates(
  snap: ProjectSnapshot,
  systemId: string,
  packages: ReadonlyMap<string, PackageResolution>,
): ImportCandidate[] {
  const index = ResourcePathIndex.fromSnapshot(snap);
  const out: ImportCandidate[] = [];
  for (const k of snap.kokostates) {
    if (k.builtin) continue;
    const spelling =
      index.spellingFor(k.id, systemId, "relative") ??
      index.spellingFor(k.id, systemId, "absolute");
    if (spelling) out.push({ name: k.name, spelling, source: "このプロジェクト" });
  }
  for (const b of BUILTIN_KOKOSTATES) {
    out.push({ name: b.name, spelling: `@builtin/${b.name}.koko`, source: "Built-in" });
  }
  for (const [alias, r] of packages) {
    if (r.status !== "ready") continue;
    for (const e of r.manifest.exports) {
      const def = e.definition as { name?: unknown } | null;
      if (e.kind !== "kokostate" || typeof def?.name !== "string") continue;
      out.push({
        name: def.name,
        spelling: `@${alias}/${e.path.replace(/^\/+/, "")}`,
        source: `@${alias}`,
      });
    }
  }
  return out;
}

/** いま書いてある import（ローカル名 → パス）と、次の import を足す位置 */
export function existingImports(state: EditorState): {
  names: Map<string, string>;
  insertAt: number;
} {
  const names = new Map<string, string>();
  let insertAt = -1;
  const tree = syntaxTree(state);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "ImportDeclaration") continue;
    const local = node.getChild("VariableDefinition");
    const path = node.getChild("String");
    if (local && path) {
      names.set(
        state.sliceDoc(local.from, local.to),
        state.sliceDoc(path.from + 1, Math.max(path.from + 1, path.to - 1)),
      );
    }
    insertAt = state.doc.lineAt(node.to).to + 1;
  }
  if (insertAt < 0) insertAt = afterLeadingComments(state);
  return { names, insertAt: Math.min(insertAt, state.doc.length) };
}

/** 先頭のコメント（説明の行）の下。なければいちばん上 */
function afterLeadingComments(state: EditorState): number {
  let at = 0;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!line.text.trimStart().startsWith("//")) break;
    at = Math.min(line.to + 1, state.doc.length);
  }
  return at;
}

const IN_TEXT = new Set(["String", "LineComment", "BlockComment", "TemplateString"]);

/**
 * import の補完：
 * - `from "` のあとは、import できる KokoState のパス
 * - `import ` のあとは、`名前 from "パス";` まで
 * - 本文で KokoState の名前を書くと、まだ import していなければ、import の行も一緒に足す
 */
export function importCompletionSource(candidates: () => ImportCandidate[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const node = syntaxTree(context.state).resolveInner(context.pos, -1);

    // from "…" の中
    const path = context.matchBefore(/\bfrom\s+["'][^"'\n]*$/);
    if (path && node.name === "String") {
      const quote = path.text.search(/["']/);
      const list = candidates();
      if (list.length === 0) return null;
      return {
        from: path.from + quote + 1,
        options: list.map((c) => ({
          label: c.spelling,
          detail: c.name,
          info: `${c.source}の KokoState`,
          type: "text",
        })),
        validFor: /^[^"'\n]*$/,
      };
    }
    if (IN_TEXT.has(node.name)) return null;

    // import 文を書き始めたところ
    const statement = context.matchBefore(/^\s*import\s+\w*$/);
    if (statement) {
      const word = /\w*$/.exec(statement.text)?.[0] ?? "";
      const { names } = existingImports(context.state);
      const options: Completion[] = candidates()
        .filter((c) => !names.has(c.name))
        .map((c) => ({
          label: c.name,
          detail: `from "${c.spelling}"`,
          info: `${c.source}の KokoState`,
          type: "class",
          apply: `${c.name} from "${c.spelling}";`,
        }));
      if (options.length === 0) return null;
      return { from: statement.to - word.length, options, validFor: /^\w*$/ };
    }

    // 本文で名前を書いたところ（e.Gun の Gun など、. のあとは除く）
    const word = context.matchBefore(/\w+$/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    if (context.state.sliceDoc(word.from - 1, word.from) === ".") return null;
    const { names, insertAt } = existingImports(context.state);
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const c of candidates()) {
      // すでに同じ名前を import していれば、それを使う（同じ名前の別のものは出さない）
      if (names.has(c.name) || seen.has(c.name)) continue;
      seen.add(c.name);
      options.push({
        label: c.name,
        detail: `import（${c.source}）`,
        info: `import ${c.name} from "${c.spelling}"; を足します`,
        type: "class",
        boost: -1,
        apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
          const line = { from: insertAt, insert: `import ${c.name} from "${c.spelling}";\n` };
          const name = { from, to, insert: c.name };
          // 元の文書の位置で、前から順に並べる
          view.dispatch({ changes: insertAt <= from ? [line, name] : [name, line] });
        },
      });
    }
    if (options.length === 0) return null;
    return { from: word.from, options, validFor: /^\w*$/ };
  };
}
