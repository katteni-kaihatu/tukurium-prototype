import { describe, expect, it } from "vitest";
import { BUILTIN } from "./builtins";
import { ResourcePathIndex } from "./resourcePath";
import type { ProjectSnapshot } from "./schema";
import { compileSystem, planImportRefactor, readSystemQuery } from "./systemCompiler";

const snap: ProjectSnapshot = {
  version: 1,
  name: "p",
  kokostates: [
    { id: "ks_gun", name: "Gun", fields: [] },
    { id: "ks_tgun", name: "Gun", fields: [] },
    { id: "ks_a", name: "Dup", fields: [] },
  ],
  systems: [{ id: "sys", name: "Shoot", code: "" }],
  materials: [{ id: "m", name: "dup", color: "#fff", roughness: 1, metalness: 0 }],
  outputs: [],
  entities: [],
  folders: [
    { id: "f_combat", name: "Combat", parent: null },
    { id: "f_states", name: "States", parent: "f_combat" },
    { id: "f_targets", name: "Targets", parent: "f_combat" },
    { id: "f_sys", name: "Systems", parent: "f_combat" },
  ],
  placement: { ks_gun: "f_states", ks_tgun: "f_targets", sys: "f_sys" },
};
const index = ResourcePathIndex.fromSnapshot(snap);
const compile = (src: string) => compileSystem("sys", src, index);
const lines = (s: string) => s.split("\n").length;

describe("compileSystem", () => {
  it("相対パスの import を安定 ID に結び付け、行の数を変えずに書き換える", () => {
    const src = `import Gun from "../States/Gun.koko";\nexport default system({ query: { with: [Gun] } });\n`;
    const out = compile(src);
    expect(out.ok).toBe(true);
    expect(out.bindings).toEqual([
      {
        alias: "Gun",
        kind: "kokostate",
        spelling: "../States/Gun.koko",
        resourceId: "ks_gun",
        name: "Gun",
        line: 1,
        range: [16, 36],
      },
    ]);
    expect(out.javascript).toContain('const Gun = __koko("ks_gun", "Gun");');
    expect(out.javascript).not.toContain("import");
    expect(lines(out.javascript)).toBe(lines(src));
  });

  it("同じ名前の KokoState を別の名前で同時に使える", () => {
    const out = compile(
      `import Gun from "../States/Gun.koko";\nimport TargetGun from "/Combat/Targets/Gun.koko";\nexport default system({});`,
    );
    expect(out.bindings.map((b) => [b.alias, b.resourceId])).toEqual([
      ["Gun", "ks_gun"],
      ["TargetGun", "ks_tgun"],
    ]);
  });

  it("@builtin/ は Built-in に結び付ける", () => {
    const out = compile(
      `import Transform from "@builtin/Transform.koko";\nexport default system({});`,
    );
    expect(out.bindings[0]).toMatchObject({ resourceId: BUILTIN.Transform, name: "Transform" });
  });

  it("複数行の import でも行の数を保つ", () => {
    const src = `import\n  Gun\n  from "../States/Gun.koko";\nexport default system({});`;
    const out = compile(src);
    expect(out.ok).toBe(true);
    expect(lines(out.javascript)).toBe(lines(src));
  });

  it("見つからない・曖昧なパスは、その行の問題にして読み込ませない", () => {
    const out = compile(
      `export default system({});\nimport A from "./Nope.koko";\nimport B from "/Dup.koko";\nimport C from "../../../x.koko";`,
    );
    expect(out.ok).toBe(false);
    expect(out.diagnostics.map((d) => [d.code, d.location])).toEqual([
      ["import-unresolved", { kind: "script", line: 2, symbol: "./Nope.koko" }],
      ["import-ambiguous", { kind: "script", line: 3, symbol: "/Dup.koko" }],
      ["import-unresolved", { kind: "script", line: 4, symbol: "../../../x.koko" }],
    ]);
    expect(out.diagnostics[0]).toMatchObject({
      provider: "script",
      phase: "authoring",
      subject: { kind: "system", id: "sys" },
    });
  });

  it("default 以外の import と、.koko 以外の import は使えない", () => {
    const out = compile(
      `import { Gun } from "../States/Gun.koko";\nimport * as G from "../States/Gun.koko";\nimport x from "./util.js";\nimport "../States/Gun.koko";`,
    );
    expect(out.diagnostics.map((d) => [d.code, scriptLine(d.location)])).toEqual([
      ["import-unsupported", 1],
      ["import-unsupported", 2],
      ["import-unsupported", 3],
      ["import-unsupported", 4],
    ]);
  });

  it("import がなければそのまま。構文の誤りは QuickJS に任せる（そのまま返す）", () => {
    const plain = `export default system({ query: { with: ["Gun"] } });`;
    expect(compile(plain)).toEqual({ ok: true, javascript: plain, bindings: [], diagnostics: [] });
    const broken = `let = ;\nexport default system({});`;
    expect(compile(broken)).toMatchObject({ ok: true, javascript: broken });
  });
});

function scriptLine(loc: unknown): number | null {
  return (loc as { line?: number | null } | null)?.line ?? null;
}

describe("readSystemQuery", () => {
  it("import した名前と、移行の間の文字列の名前の両方を ID に読み替える", () => {
    const q = readSystemQuery(
      "sys",
      `import G from "../States/Gun.koko";\nimport T from "@builtin/Transform.koko";\nexport default system({\n  query: { with: [G, "Dup", T], without: ["Nope"] },\n});`,
      index,
    );
    expect(q).toEqual({
      with: [
        { name: "Gun", id: "ks_gun" },
        { name: "Dup", id: "ks_a" },
        { name: "Transform", id: BUILTIN.Transform },
      ],
      without: [{ name: "Nope", id: null }],
    });
  });

  it("名前が二つ以上の KokoState に当てはまるときは ID を決めない", () => {
    expect(
      readSystemQuery("sys", `export default system({ query: { with: ["Gun"] } });`, index).with,
    ).toEqual([{ name: "Gun", id: null }]);
  });

  it("system() で包まない書き方・構文の誤り・query なし", () => {
    expect(
      readSystemQuery("sys", `export default { query: { with: ["Dup"] } };`, index).with,
    ).toEqual([{ name: "Dup", id: "ks_a" }]);
    expect(readSystemQuery("sys", "let = ;", index)).toEqual({ with: [], without: [] });
    expect(readSystemQuery("sys", "export default system({});", index)).toEqual({
      with: [],
      without: [],
    });
  });
});

describe("planImportRefactor（名前の変更・移動に合わせて import を書き直す）", () => {
  function project(code: string, over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
    return {
      ...snap,
      kokostates: [
        { id: "ks_gun", name: "Gun", fields: [] },
        { id: "ks_hp", name: "Health", fields: [] },
      ],
      systems: [{ id: "sys", name: "Shoot", code }],
      materials: [],
      placement: { ks_gun: "f_states", ks_hp: "f_states", sys: "f_sys" },
      ...over,
    };
  }
  const apply = (code: string, edits: ReturnType<typeof planImportRefactor>) => {
    let out = code;
    for (const e of [...edits].sort((a, b) => b.start - a.start))
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
  };
  const CODE = `import Gun from "../States/Gun.koko";\nimport T from "@builtin/Transform.koko";\nimport Hp from "/Combat/States/Health.koko";\nexport default system({});`;

  it("KokoState の名前を変えると、それを指す import だけを書き直す（相対は相対、絶対は絶対のまま）", () => {
    const prev = project(CODE);
    const next = project(CODE, {
      kokostates: [
        { id: "ks_gun", name: "Rifle", fields: [] },
        { id: "ks_hp", name: "Life", fields: [] },
      ],
    });
    const edits = planImportRefactor(prev, next);
    expect(edits.every((e) => e.systemId === "sys")).toBe(true);
    expect(apply(CODE, edits)).toBe(
      `import Gun from "../States/Rifle.koko";\nimport T from "@builtin/Transform.koko";\nimport Hp from "/Combat/States/Life.koko";\nexport default system({});`,
    );
  });

  it("KokoState を別のフォルダへ移すと、System からの新しい相対パスにする", () => {
    const prev = project(CODE);
    const next = project(CODE, { placement: { ks_gun: "f_sys", ks_hp: "f_states", sys: "f_sys" } });
    expect(apply(CODE, planImportRefactor(prev, next)).split("\n")[0]).toBe(
      'import Gun from "./Gun.koko";',
    );
  });

  it("System を移すと、その System の相対パスを書き直す", () => {
    const prev = project(CODE);
    const next = project(CODE, {
      placement: { ks_gun: "f_states", ks_hp: "f_states", sys: "f_combat" },
    });
    expect(apply(CODE, planImportRefactor(prev, next)).split("\n")[0]).toBe(
      'import Gun from "./States/Gun.koko";',
    );
  });

  it("フォルダの名前を変えると、そのフォルダを通るパスを書き直す", () => {
    const prev = project(CODE);
    const next = project(CODE, {
      folders: (snap.folders ?? []).map((f) => (f.id === "f_states" ? { ...f, name: "Parts" } : f)),
    });
    const out = apply(CODE, planImportRefactor(prev, next));
    expect(out).toContain('"../Parts/Gun.koko"');
    expect(out).toContain('"/Combat/Parts/Health.koko"');
  });

  it("関係のない変更・もともと解決できない import には手を付けない", () => {
    const broken = `import X from "./Nope.koko";\n${CODE}`;
    const prev = project(broken);
    expect(planImportRefactor(prev, project(broken))).toEqual([]);
    const next = project(broken, {
      kokostates: [
        { id: "ks_gun", name: "Rifle", fields: [] },
        { id: "ks_hp", name: "Health", fields: [] },
      ],
    });
    expect(planImportRefactor(prev, next).map((e) => e.text)).toEqual(['"../States/Rifle.koko"']);
  });

  it("書き直した先が消えていたら（削除）手を付けない", () => {
    const prev = project(CODE);
    const next = project(CODE, { kokostates: [{ id: "ks_hp", name: "Health", fields: [] }] });
    expect(planImportRefactor(prev, next)).toEqual([]);
  });
});
