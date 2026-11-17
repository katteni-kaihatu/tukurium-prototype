import { CompletionContext } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ProjectDoc } from "@tukurium/repo-model";
import type { EditorCompletion, EditorHover } from "@tukurium/typecheck";
import { afterEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({ project: null as ProjectDoc | null, rev: 0 }));
vi.mock("./store", () => ({
  useWorkspace: {
    getState: () => workspace,
    setState: (next: Partial<typeof workspace>) => Object.assign(workspace, next),
  },
}));

import { editorCompletionSource, queryEditor } from "./editorIntelligence";
import type { ImportCandidate } from "./importCompletion";
import { useWorkspace } from "./store";
import { setEditorTypecheck, type TypecheckClient } from "./typecheckClient";

afterEach(() => {
  setEditorTypecheck(null);
  useWorkspace.setState({ project: null });
});

describe("古い型情報を表示しない", () => {
  for (const change of ["local", "remote", "workspace", "closed", "none"] as const) {
    it(`${change}：問い合わせ後の本文・共同編集の版・表示先を確かめる`, async () => {
      let reply: ((result: EditorHover) => void) | undefined;
      const result: EditorHover = {
        display: "const value: number",
        documentation: "",
        from: 0,
        to: 5,
        diagnostics: [],
        definition: null,
      };
      setEditorTypecheck({
        query: () =>
          new Promise<EditorHover>((resolve) => {
            reply = resolve;
          }),
      } as unknown as TypecheckClient);
      useWorkspace.setState({ project: new ProjectDoc(), rev: 1 });
      const view = { state: { doc: Text.of(["value"]) }, dom: { isConnected: true } };
      const pending = queryEditor(view as unknown as EditorView, "code", {
        kind: "hover",
        position: 1,
      });
      if (change === "local") view.state.doc = Text.of(["changed"]);
      if (change === "remote") useWorkspace.setState({ rev: 2 });
      if (change === "workspace") useWorkspace.setState({ project: new ProjectDoc() });
      if (change === "closed") view.dom.isConnected = false;
      reply?.(result);
      expect(await pending).toEqual(change === "none" ? result : null);
    });
  }
});

describe("入力の候補の合成", () => {
  const candidates = (): ImportCandidate[] => [
    { name: "Target", spelling: "./Target.koko", source: "このプロジェクト" },
    { name: "Gun", spelling: "./Gun.koko", source: "このプロジェクト" },
  ];

  function setup(doc: string, entries: EditorCompletion[] | null) {
    const state = EditorState.create({ doc, extensions: [javascript()] });
    ensureSyntaxTree(state, state.doc.length);
    const view = { state, dom: { isConnected: true } } as unknown as EditorView;
    useWorkspace.setState({ project: new ProjectDoc(), rev: 1 });
    if (entries === null) {
      setEditorTypecheck(null);
    } else {
      setEditorTypecheck({
        query: async () => entries,
      } as unknown as TypecheckClient);
    }
    const source = editorCompletionSource("sys_test", candidates, () => view);
    return source(new CompletionContext(state, doc.length, false));
  }

  it("本文では TypeScript の候補に自動 import を合成し、同名は TypeScript 側を残す", async () => {
    const result = await setup("const a = Tar", [{ name: "Target", kind: "const", sortText: "1" }]);
    const labels = result?.options.map((o) => o.label) ?? [];
    expect(labels).toEqual(["Target", "Gun"]);
    // 先頭の Target は TypeScript の候補（const → constant）で、自動 import の分は重ねない
    expect(result?.options[0]?.type).toBe("constant");
    expect(result?.options[1]?.boost).toBe(-1);
  });

  it("TypeScript の答えが無くても、自動 import の候補だけは返す", async () => {
    const result = await setup("const a = Tar", null);
    expect(result?.options.map((o) => o.label)).toEqual(["Target", "Gun"]);
  });

  it(". のあとでは自動 import を合成しない", async () => {
    const result = await setup("const a = e.Tar", [
      { name: "Target", kind: "const", sortText: "1" },
    ]);
    expect(result?.options.map((o) => o.label)).toEqual(["Target"]);
    expect(result?.options[0]?.type).toBe("constant");
  });

  it("import 文では、自前の名前候補を単独で返す", async () => {
    const result = await setup("import Gu", [{ name: "Target", kind: "const", sortText: "1" }]);
    const gun = result?.options.find((o) => o.label === "Gun");
    expect(gun?.apply).toBe('Gun from "./Gun.koko";');
  });
});
