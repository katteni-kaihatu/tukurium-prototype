import {
  gunAndTargetSample,
  marubatsuSample,
  type OfficialLibrary,
  officialLibraries,
  type PackageDependency,
  type PackageResolution,
  type ProjectSnapshot,
  packageManifest,
  referenceDoorAndSwitch,
  referenceGunAndTarget,
  referenceKeyAndDoor,
} from "@tukurium/repo-model";
import { hostApiDeclarations } from "@tukurium/runtime";
import { describe, expect, it } from "vitest";
import { TypeChecker } from "./checker";
import { nodeTypeCheckerOptions } from "./node";

const checker = new TypeChecker(nodeTypeCheckerOptions());
const host = hostApiDeclarations();
const check = (snapshot: ProjectSnapshot, systemIds?: string[]) =>
  checker.check({ snapshot, packages: new Map(), hostDeclarations: host, systemIds });

/** 銃と的のサンプルに、System を一つ足す */
function withSystem(code: string): ProjectSnapshot {
  const s = gunAndTargetSample();
  s.systems.push({ id: "sys_t", name: "T", code });
  return s;
}

describe("TypeChecker", () => {
  it("Host API の宣言そのものに誤りがない", () => {
    expect(
      checker.checkHost({
        snapshot: gunAndTargetSample(),
        packages: new Map(),
        hostDeclarations: host,
      }),
    ).toEqual([]);
  });

  it("同梱サンプル「銃と的」は、厳しい判定でも型の誤りがない", () => {
    expect(check(gunAndTargetSample()).map((d) => `${d.subject.id}:${d.message}`)).toEqual([]);
  });

  it("KokoState の欄の名前の打ち間違いを、その行の型の誤りにする（日本語の文）", () => {
    const d = check(
      withSystem(
        [
          'import Gun from "./Gun.koko";',
          "export default system({",
          "  query: { with: [Gun] },",
          "  onUpdate(e) {",
          "    e.get(Gun).ammmo = 1;",
          "  },",
          "});",
        ].join("\n"),
      ),
      ["sys_t"],
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      provider: "types",
      phase: "authoring",
      severity: "error",
      subject: { kind: "system", id: "sys_t" },
      location: { kind: "script", line: 5 },
    });
    expect(d[0]?.message).toContain("ammmo");
    expect(d[0]?.message).toMatch(/[ぁ-ん]/);
  });

  it("Query の with に書いていない KokoState を e.get() に渡すと、型の誤りにする", () => {
    const d = check(
      withSystem(
        [
          'import Gun from "./Gun.koko";',
          'import Target from "./Target.koko";',
          "export default system({",
          "  query: { with: [Gun] },",
          "  onUpdate(e) {",
          "    e.get(Target).hp = 0;",
          "  },",
          "});",
        ].join("\n"),
      ),
      ["sys_t"],
    );
    expect(d.map((x) => (x.location?.kind === "script" ? x.location.line : null))).toEqual([6]);
  });

  it("欄の型が合わない代入と、見つからない import を型の誤りにする", () => {
    const d = check(
      withSystem(
        [
          'import Gun from "./Gun.koko";',
          'import Nope from "./Nope.koko";',
          "export default system({",
          "  query: { with: [Gun] },",
          '  onUpdate(e) { e.get(Gun).ammo = "x"; },',
          "});",
        ].join("\n"),
      ),
      ["sys_t"],
    );
    expect(d.map((x) => (x.location?.kind === "script" ? x.location.line : null)).sort()).toEqual([
      2, 5,
    ]);
  });
});

describe("公式のもの（ADR 0058：公式のものは型の誤りなく書く）", () => {
  const dep = (l: OfficialLibrary): PackageDependency => ({
    alias: l.alias,
    packageId: l.workId,
    version: 1,
    contentHash: "h",
  });
  const libs = officialLibraries();
  const lib = (alias: string) => libs.find((l) => l.alias === alias) as OfficialLibrary;
  const resolved = (l: OfficialLibrary): Map<string, PackageResolution> =>
    new Map([
      [
        l.alias,
        { status: "ready", dependency: dep(l), manifest: packageManifest(l.snapshot, l.outputId) },
      ],
    ]);
  const errors = (snapshot: ProjectSnapshot, packages = new Map<string, PackageResolution>()) =>
    checker
      .check({ snapshot, packages, hostDeclarations: host })
      .map(
        (d) =>
          `${d.subject.id}:${d.location?.kind === "script" ? d.location.line : ""}:${d.message}`,
      );

  it("公式ライブラリそのもの（combat・interaction・items）", () => {
    for (const l of libs) expect(errors(l.snapshot)).toEqual([]);
  });

  it("公式ライブラリを使うサンプル（銃と的・扉とスイッチ・鍵と扉）", () => {
    const combat = lib("combat");
    const interaction = lib("interaction");
    const items = lib("items");
    expect(errors(referenceGunAndTarget(dep(combat)), resolved(combat))).toEqual([]);
    expect(errors(referenceDoorAndSwitch(dep(interaction)), resolved(interaction))).toEqual([]);
    expect(errors(referenceKeyAndDoor(dep(items)), resolved(items))).toEqual([]);
  });

  it("マルバツ", () => {
    expect(errors(marubatsuSample())).toEqual([]);
  });
});
