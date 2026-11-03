import { describe, expect, it } from "vitest";
import { dirtyRefs } from "./dependencyGraph";
import { checkProjectReferences } from "./diagnostics";
import { fromFiles, toFiles } from "./files";
import {
  isPackageResourceId,
  type PackageResolution,
  packageKokoStates,
  packageResourceId,
  resolutionMap,
  validateAlias,
} from "./packageDependency";
import { type PackageManifest, packageManifest } from "./packageManifest";
import { ProjectDoc } from "./projectDoc";
import { ResourcePathIndex } from "./resourcePath";
import { gunAndTargetSample } from "./samples";
import type { PackageDependency, ProjectSnapshot } from "./schema";
import { compileSystem } from "./systemCompiler";

const dep: PackageDependency = {
  alias: "combat",
  packageId: "w_lib",
  version: 3,
  contentHash: "h3",
};

/** 依存先のライブラリ：States/Health.koko を公開、States/Secret.koko は公開していない */
function library(): PackageManifest {
  const s: ProjectSnapshot = {
    version: 1,
    name: "lib",
    kokostates: [
      { id: "ks_health", name: "Health", fields: [] },
      { id: "ks_secret", name: "Secret", fields: [] },
    ],
    systems: [],
    materials: [],
    outputs: [],
    entities: [],
    folders: [{ id: "f_states", name: "States", parent: null }],
    placement: { ks_health: "f_states", ks_secret: "f_states" },
    exports: ["ks_health"],
  };
  return packageManifest(s);
}

const ready = (d = dep): Map<string, PackageResolution> =>
  new Map([[d.alias, { status: "ready", dependency: d, manifest: library() }]]);

const project = () => {
  const s = gunAndTargetSample();
  s.dependencies = [dep];
  return s;
};
const compile = (src: string, packages?: ReadonlyMap<string, PackageResolution>) =>
  compileSystem("sys_shoot", src, ResourcePathIndex.fromSnapshot(project()), packages);

describe("プロジェクトの依存（ADR 0015）", () => {
  it("足す・外すと、制作データの dependencies に別名の順で入る", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    p.addDependency({ ...dep, alias: "z" });
    p.addDependency({ ...dep, alias: "a", packageId: "w_other" });
    expect(p.snapshot().dependencies?.map((d) => d.alias)).toEqual(["a", "z"]);
    p.removeDependency("z");
    expect(p.dependencies().map((d) => d.alias)).toEqual(["a"]);
  });

  it("同じ別名・同じ Package を二つ足せない（Package は一つの版に固定する）", () => {
    const p = new ProjectDoc();
    p.addDependency(dep);
    expect(() => p.addDependency({ ...dep, packageId: "w_other" })).toThrow(/別名/);
    expect(() => p.addDependency({ ...dep, alias: "other", version: 4 })).toThrow(/もう/);
  });

  it("別名に使えない書き方を拒む", () => {
    expect(validateAlias("combat")).toBeNull();
    expect(validateAlias("戦闘")).toBeNull();
    expect(validateAlias("")).not.toBeNull();
    expect(validateAlias("a/b")).not.toBeNull();
    expect(validateAlias("@a")).not.toBeNull();
    expect(validateAlias("a b")).not.toBeNull();
    expect(validateAlias("builtin")).not.toBeNull();
    expect(validateAlias("BuiltIn")).not.toBeNull();
  });

  it("ファイル（tukurium.json）に書き出して読み戻しても残る", () => {
    const back = fromFiles(toFiles(project()));
    expect(back.dependencies).toEqual([dep]);
    // 依存がなければ、今までと同じ書き方（空の配列）のまま
    expect(toFiles(gunAndTargetSample())["tukurium.json"]).toContain('"dependencies": []');
  });

  it("読み込み直すと依存も入れ替わる", () => {
    const p = new ProjectDoc();
    p.addDependency({ ...dep, alias: "old" });
    p.load(project());
    expect(p.dependencies()).toEqual([dep]);
  });
});

describe("@別名 の import", () => {
  const src = (spelling: string) =>
    `import Health from "${spelling}";\nexport default system({ query: { with: [Health] } });\n`;

  it("公開された KokoState を、Package と版で区切った ID に結び付ける", () => {
    const out = compile(src("@combat/States/Health.koko"), ready());
    expect(out.ok).toBe(true);
    const id = packageResourceId(dep, "ks_health");
    expect(out.bindings).toEqual([
      expect.objectContaining({
        alias: "Health",
        resourceId: id,
        name: "Health",
        package: "combat",
      }),
    ]);
    expect(out.javascript).toContain(`const Health = __koko(${JSON.stringify(id)}, "Health");`);
    expect(out.packageImports).toEqual(["combat"]);
  });

  it("フォルダ・名前の大文字小文字は区別しない", () => {
    expect(compile(src("@combat/states/health.koko"), ready()).ok).toBe(true);
  });

  it("Package ID と版が違えば、同じ元の ID でも別の ID になる", () => {
    expect(packageResourceId(dep, "ks_health")).not.toBe(
      packageResourceId({ ...dep, version: 4 }, "ks_health"),
    );
    expect(packageResourceId(dep, "ks_health")).not.toBe("ks_health");
  });

  it("依存にない別名は問題にする", () => {
    const out = compile(src("@nope/States/Health.koko"), ready());
    expect(out.ok).toBe(false);
    expect(out.diagnostics[0]).toMatchObject({ code: "import-package-unknown" });
  });

  it("公開していないもの・ないものは、区別せず「見つからない」にする", () => {
    const hidden = compile(src("@combat/States/Secret.koko"), ready());
    const missing = compile(src("@combat/States/Nothing.koko"), ready());
    expect(hidden.diagnostics[0]?.code).toBe("import-package-not-found");
    expect(missing.diagnostics[0]?.code).toBe("import-package-not-found");
    expect(hidden.diagnostics[0]?.message.replace("Secret", "Nothing")).toBe(
      missing.diagnostics[0]?.message,
    );
  });

  it("中身を取り出せない依存は、その理由を問題にする", () => {
    const out = compile(
      src("@combat/States/Health.koko"),
      new Map([
        ["combat", { status: "unavailable", dependency: dep, message: "使う許可がありません" }],
      ]),
    );
    expect(out.ok).toBe(false);
    expect(out.diagnostics[0]).toMatchObject({
      code: "import-package-unavailable",
      message: expect.stringContaining("使う許可がありません"),
    });
  });

  it("依存の中身を渡さないときは、解決できないことを問題にする", () => {
    const out = compile(src("@combat/States/Health.koko"));
    expect(out.ok).toBe(false);
    expect(out.diagnostics[0]).toMatchObject({
      code: "import-package-unavailable",
      message: expect.stringContaining("渡されていない"),
    });
    expect(out.packageImports).toEqual(["combat"]);
  });

  it("@builtin は今までどおり Built-in を指す", () => {
    const out = compile(src("@builtin/Transform.koko"), ready());
    expect(out.ok).toBe(true);
    expect(out.packageImports).toEqual([]);
  });
});

describe("依存を変えたときの調べ直し", () => {
  it("依存の版を変えると、その別名を import している System だけを調べ直す", () => {
    const before = project();
    before.systems = [
      ...before.systems,
      { id: "sys_lib", name: "UseLib", code: `import H from "@combat/States/Health.koko";` },
    ];
    const after = structuredClone(before);
    after.dependencies = [{ ...dep, version: 4, contentHash: "h4" }];
    const dirty = dirtyRefs(before, after).filter((r) => r.kind === "system");
    expect(dirty.map((r) => r.id)).toEqual(["sys_lib"]);
  });
});

describe("実行時の取り込み（ADR 0015）", () => {
  it("公開された KokoState の定義を、Package と版で区切った ID で取り出す", () => {
    const defs = packageKokoStates(ready().values());
    expect(defs).toEqual([{ id: packageResourceId(dep, "ks_health"), name: "Health", fields: [] }]);
    expect(isPackageResourceId(defs[0]?.id ?? "")).toBe(true);
  });

  it("使えない依存からは何も取り出さない", () => {
    expect(packageKokoStates([{ status: "unavailable", dependency: dep, message: "x" }])).toEqual(
      [],
    );
  });

  it("届いた結果が lock と違う・届いていない依存は、使えないものにする", () => {
    const other = { ...dep, alias: "other", packageId: "w_other" };
    const map = resolutionMap(
      [dep, other],
      [{ status: "ready", dependency: { ...dep, version: 4 }, manifest: library() }],
    );
    expect(map.get("combat")?.status).toBe("unavailable");
    expect(map.get("other")).toMatchObject({ status: "unavailable" });
    expect(resolutionMap([dep], [...ready().values()]).get("combat")?.status).toBe("ready");
  });

  it("制作データには入れずに、Entity に付けられる（Inspector と同じ道）", () => {
    const p = new ProjectDoc();
    p.load(project());
    p.setPackageKokoStates(packageKokoStates(ready().values()));
    const id = packageResourceId(dep, "ks_health");
    expect(p.registry().get(id)?.name).toBe("Health");
    p.addState("ent_gun", id);
    expect(p.entity("ent_gun")?.states[id]).toEqual({});
    expect(p.snapshot().kokostates.some((k) => k.id === id)).toBe(false);
  });

  it("今の依存にない版の KokoState を持つ Entity は注意にする", () => {
    const s = project();
    const id = packageResourceId(dep, "ks_health");
    const gun = s.entities.find((e) => e.id === "ent_gun");
    if (gun) gun.states[id] = {};
    expect(checkProjectReferences(s).filter((d) => d.code.includes("kokostate"))).toEqual([]);
    s.dependencies = [{ ...dep, version: 4, contentHash: "h4" }];
    expect(checkProjectReferences(s).map((d) => d.code)).toContain(
      "package-kokostate-not-in-dependencies",
    );
  });
});
