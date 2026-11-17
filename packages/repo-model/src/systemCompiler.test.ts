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

  it("import がなければそのまま。書き方の誤りは、型を消す段階でその行の問題にする", () => {
    const plain = `export default system({ query: { with: ["Gun"] } });`;
    expect(compile(plain)).toEqual({
      ok: true,
      javascript: plain,
      bindings: [],
      diagnostics: [],
      packageImports: [],
    });
    const broken = `export default system({});\nlet = ;`;
    const r = compile(broken);
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "script-syntax", location: { kind: "script", line: 2 } }),
    ]);
  });

  it("TypeScript の型を消して読む。行の数は変わらず、import のパスの範囲は元のコードを指す", () => {
    const ts = [
      "interface Cfg { speed: number }",
      `const cfg: Cfg = { speed: 2 }; import Gun from "../States/Gun.koko";`,
      "export default system({",
      "  query: { with: [Gun] },",
      "  onUpdate(e, dt: number) { const n = dt as number; },",
      "});",
    ].join("\n");
    const r = compile(ts);
    expect(r.ok).toBe(true);
    expect(r.javascript.split("\n")).toHaveLength(6);
    expect(r.javascript).not.toContain("interface");
    const b = r.bindings[0];
    expect(b?.line).toBe(2);
    expect(ts.slice(b?.range[0], b?.range[1])).toBe('"../States/Gun.koko"');
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

describe("プレハブ・マテリアル・素材の import（ADR 0082）", () => {
  const project: ProjectSnapshot = {
    ...snap,
    assets: [{ id: "a_shot", name: "shot", kind: "audio", contentType: "audio/wav" }],
    materials: [{ id: "m_wood", name: "wood", color: "#fff", roughness: 1, metalness: 0 }],
    prefabs: [{ id: "pf_bullet", name: "Bullet", root: "r", systems: [], keep: [] }],
    prefabEntities: [
      { id: "r", name: "Bullet", prefab: "pf_bullet", parent: null, order: 0, states: {} },
    ],
    placement: { ...snap.placement, pf_bullet: "f_states" },
  };
  const idx = ResourcePathIndex.fromSnapshot(project);
  const run = (src: string) => compileSystem("sys", src, idx);

  it("値は、リソースの ID の文字になる。行の数は変えない", () => {
    const src = [
      'import Bullet from "../States/Bullet.prefab";',
      'import Wood from "/wood.material";',
      'import Shot from "/shot.audio";',
      "export default system({});",
    ].join("\n");
    const out = run(src);
    expect(out.diagnostics.map((d) => d.message)).toEqual([]);
    expect(out.javascript.split("\n").slice(0, 3)).toEqual([
      'const Bullet = "pf_bullet";',
      'const Wood = "m_wood";',
      'const Shot = "a_shot";',
    ]);
    expect(lines(out.javascript)).toBe(lines(src));
    expect(out.bindings.map((b) => [b.alias, b.kind, b.resourceId])).toEqual([
      ["Bullet", "prefab", "pf_bullet"],
      ["Wood", "material", "m_wood"],
      ["Shot", "asset", "a_shot"],
    ]);
  });

  it("ないものと、種類の違う拡張子は、問題にする", () => {
    const out = run(
      ['import A from "/Nai.prefab";', 'import B from "../States/Bullet.material";'].join("\n"),
    );
    expect(out.diagnostics.map((d) => [d.code, d.location])).toEqual([
      ["import-unresolved", expect.objectContaining({ line: 1 })],
      ["import-unresolved", expect.objectContaining({ line: 2 })],
    ]);
    expect(out.diagnostics[0]?.message).toContain("プレハブ");
  });

  it("Query には、import した KokoState だけが読み替わる（プレハブは KokoState として読まない）", () => {
    const src = `import Bullet from "../States/Bullet.prefab";\nimport Gun from "../States/Gun.koko";\nexport default system({ query: { with: [Gun, Bullet] } });`;
    expect(readSystemQuery("sys", src, idx).with).toEqual([
      { name: "Gun", id: "ks_gun" },
      { name: "Bullet", id: null },
    ]);
  });

  it("名前を変えると、プレハブの import のパスも書き直す", () => {
    const withSystem = (p: ProjectSnapshot): ProjectSnapshot => ({
      ...p,
      systems: [
        { id: "sys", name: "Shoot", code: 'import Bullet from "../States/Bullet.prefab";\n' },
      ],
    });
    const next = withSystem({
      ...project,
      prefabs: [{ id: "pf_bullet", name: "Shell", root: "r", systems: [], keep: [] }],
    });
    expect(planImportRefactor(withSystem(project), next).map((e) => e.text)).toEqual([
      '"../States/Shell.prefab"',
    ]);
  });
});
