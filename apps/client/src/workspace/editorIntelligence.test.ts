import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ProjectDoc } from "@tukurium/repo-model";
import type { EditorHover } from "@tukurium/typecheck";
import { afterEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({ project: null as ProjectDoc | null, rev: 0 }));
vi.mock("./store", () => ({
  useWorkspace: {
    getState: () => workspace,
    setState: (next: Partial<typeof workspace>) => Object.assign(workspace, next),
  },
}));

import { queryEditor } from "./editorIntelligence";
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
