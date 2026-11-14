import { CompletionContext } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { gunAndTargetSample, type ProjectSnapshot } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { importCandidates, importCompletionSource } from "./importCompletion";

function sample(): ProjectSnapshot {
  const snap = gunAndTargetSample();
  // KokoState を States フォルダ、スクリプトを Scripts フォルダに置く
  snap.folders = [
    { id: "fld_states", name: "States", parent: null },
    { id: "fld_scripts", name: "Scripts", parent: null },
  ];
  snap.placement = { ks_gun: "fld_states", sys_shoot: "fld_scripts" };
  return snap;
}

function stateOf(doc: string) {
  const state = EditorState.create({ doc, extensions: [javascript()] });
  ensureSyntaxTree(state, state.doc.length);
  return state;
}

function complete(doc: string, explicit = false) {
  const state = stateOf(doc);
  const source = importCompletionSource(() => importCandidates(sample(), "sys_shoot", new Map()));
  return source(new CompletionContext(state, doc.length, explicit));
}

describe("importCandidates", () => {
  it("プロジェクトのものはスクリプトの場所からの相対パス、Built-in は @builtin/", () => {
    const list = importCandidates(sample(), "sys_shoot", new Map());
    expect(list).toContainEqual({
      name: "Gun",
      spelling: "../States/Gun.koko",
      source: "このプロジェクト",
    });
    expect(list).toContainEqual({
      name: "Transform",
      spelling: "@builtin/Transform.koko",
      source: "Built-in",
    });
  });
});

describe("importCompletionSource", () => {
  it("from の文字列の中では、パスを出す", () => {
    const result = complete('import Gun from "../');
    expect(result?.options.map((o) => o.label)).toContain("../States/Gun.koko");
    expect(result?.from).toBe('import Gun from "'.length);
  });

  it("一重引用符のパスも出す", () => {
    expect(complete("import Gun from '../")?.options.map((o) => o.label)).toContain(
      "../States/Gun.koko",
    );
  });

  it("import の名前と本文では TypeScript の候補と重ねない", () => {
    expect(complete("import Gu")).toBeNull();
    expect(complete('import Gun from "../States/Gun.koko";\nconst a = Tar')).toBeNull();
  });

  it(". のあと・文字列やコメントの中では出さない", () => {
    expect(complete("e.Gu")).toBeNull();
    expect(complete('log("Gu')).toBeNull();
    expect(complete("// Gu")).toBeNull();
  });
});
