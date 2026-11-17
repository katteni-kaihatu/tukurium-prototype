import { CompletionContext } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { gunAndTargetSample, type ProjectSnapshot } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import {
  autoImportCompletion,
  existingImports,
  importCandidates,
  importCompletionSource,
} from "./importCompletion";

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

function complete(doc: string, snap: ProjectSnapshot = sample(), explicit = false) {
  const state = stateOf(doc);
  const source = importCompletionSource(() => importCandidates(snap, "sys_shoot", new Map()));
  return source(new CompletionContext(state, doc.length, explicit));
}

function auto(doc: string, snap: ProjectSnapshot = sample(), explicit = false) {
  const state = stateOf(doc);
  return autoImportCompletion(new CompletionContext(state, doc.length, explicit), () =>
    importCandidates(snap, "sys_shoot", new Map()),
  );
}

describe("importCandidates", () => {
  it("プレハブ・マテリアルも、import のパスの候補に出る（ADR 0082）", () => {
    const snap = sample();
    snap.prefabs = [{ id: "pf_bullet", name: "Bullet", root: "r", systems: [], keep: [] }];
    snap.placement = { ...snap.placement, pf_bullet: "fld_states" };
    const list = importCandidates(snap, "sys_shoot", new Map());
    expect(list).toContainEqual({
      name: "Bullet",
      spelling: "../States/Bullet.prefab",
      source: "このプロジェクト",
    });
    expect(list.some((c) => c.spelling.endsWith(".material"))).toBe(true);
  });

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

  it("import のあとでは、名前からパスまで入れる", () => {
    const result = complete("import Gu");
    const gun = result?.options.find((o) => o.label === "Gun");
    expect(gun?.apply).toBe('Gun from "../States/Gun.koko";');
  });

  it("import のあとでは、import 済みのものは出さない", () => {
    const result = complete('import Gun from "../States/Gun.koko";\nimport Gu');
    expect(result?.options.map((o) => o.label)).not.toContain("Gun");
  });

  it("識別子にできない名前は、名前の候補に出さず、パスには出す", () => {
    const snap = sample();
    snap.prefabs = [
      { id: "pf_bullet", name: "Bullet", root: "r", systems: [], keep: [] },
      { id: "pf_dan", name: "弾", root: "r", systems: [], keep: [] },
    ];
    snap.placement = { ...snap.placement, pf_bullet: "fld_states", pf_dan: "fld_states" };
    const statement = complete("import Bu", snap);
    expect(statement?.options.map((o) => o.label)).toContain("Bullet");
    expect(statement?.options.map((o) => o.label)).not.toContain("弾");
    expect(auto("const a = Bu", snap)?.options.map((o) => o.label)).not.toContain("弾");
    const path = complete('import X from "../', snap);
    expect(path?.options.map((o) => o.label)).toContain("../States/弾.prefab");
  });

  it(". のあと・文字列やコメントの中では出さない", () => {
    expect(complete("e.Gu")).toBeNull();
    expect(complete('log("Gu')).toBeNull();
    expect(complete("// Gu")).toBeNull();
  });
});

describe("autoImportCompletion", () => {
  it("本文で名前を書くと、import の行を足す候補を出す（import 済みのものは出さない）", () => {
    const result = auto('import Gun from "../States/Gun.koko";\nconst a = Tar');
    const labels = result?.options.map((o) => o.label) ?? [];
    expect(labels).toContain("Target");
    expect(labels).not.toContain("Gun");
    // TypeScript の候補より後ろに出す
    expect(result?.options.find((o) => o.label === "Target")?.boost).toBe(-1);
  });

  it(". のあと・文字列やコメントの中では出さない", () => {
    expect(auto("e.Gu")).toBeNull();
    expect(auto('log("Gu')).toBeNull();
    expect(auto("// Gu")).toBeNull();
  });
});

describe("existingImports", () => {
  it("import の名前とパス、次の import を足す位置（最後の import の次の行）", () => {
    const doc = '// 説明\nimport Gun from "./Gun.koko";\nexport default system({});\n';
    const { names, insertAt } = existingImports(stateOf(doc));
    expect(names.get("Gun")).toBe("./Gun.koko");
    expect(insertAt).toBe(doc.indexOf("export"));
  });

  it("import がなければ、先頭のコメントの下", () => {
    const doc = "// 説明\nexport default system({});\n";
    expect(existingImports(stateOf(doc)).insertAt).toBe(doc.indexOf("export"));
  });

  it("import type が混ざっても、名前には入れず、足す位置は最後の import の下", () => {
    const doc =
      'import Gun from "./Gun.koko";\nimport type { Card } from "./Card.types";\nconst a = 1;\n';
    const { names, insertAt } = existingImports(stateOf(doc));
    expect([...names.keys()]).toEqual(["Gun"]);
    expect(insertAt).toBe(doc.indexOf("const"));
  });
});
