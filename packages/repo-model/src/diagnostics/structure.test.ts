import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../schema";
import { checkProjectStructure } from "./structure";
import { dedupeDiagnostics, makeDiagnostic } from "./types";

function snap(over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    version: 1,
    name: "p",
    kokostates: [],
    systems: [],
    materials: [],
    assets: [],
    outputs: [],
    entities: [],
    folders: [],
    placement: {},
    ...over,
  };
}
const koko = (id: string, name: string) => ({ id, name, fields: [] });

describe("checkProjectStructure", () => {
  it("問題のない制作データでは何も出さない", () => {
    expect(
      checkProjectStructure(
        snap({
          kokostates: [koko("ks_a", "Gun"), koko("ks_b", "Gun")],
          folders: [
            { id: "f_a", name: "A", parent: null },
            { id: "f_b", name: "B", parent: null },
          ],
          placement: { ks_a: "f_a", ks_b: "f_b" },
        }),
      ),
    ).toEqual([]);
  });

  it("同じ親の直下で名前がぶつかると、その場所を対象に一件だけ出す", () => {
    const ds = checkProjectStructure(
      snap({
        kokostates: [koko("ks", "Gun")],
        systems: [{ id: "sy", name: "gun", code: "" }],
        folders: [{ id: "f", name: "Weapons", parent: null }],
        placement: { ks: "f", sy: "f" },
      }),
    );
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      code: "name-collision",
      severity: "error",
      phase: "authoring",
      provider: "structure",
      subject: { kind: "folder", id: "f" },
      related: [
        { kind: "kokostate", id: "ks" },
        { kind: "system", id: "sy" },
      ],
    });
    expect(ds[0]?.message).toContain("Gun");
  });

  it("いちばん上での衝突はプロジェクトを対象にする", () => {
    const ds = checkProjectStructure(snap({ materials: [mat("m1", "Wood"), mat("m2", "wood")] }));
    expect(ds.map((d) => [d.code, d.subject])).toEqual([
      ["name-collision", { kind: "project", id: "project" }],
    ]);
  });

  it("使えない名前を、そのリソースを対象に出す", () => {
    const ds = checkProjectStructure(
      snap({ kokostates: [koko("ks", "a/b")], folders: [{ id: "f", name: "..", parent: null }] }),
    );
    expect(ds.map((d) => [d.code, d.subject.id]).sort()).toEqual([
      ["name-invalid", "f"],
      ["name-invalid", "ks"],
    ]);
    expect(ds.every((d) => d.location?.kind === "name")).toBe(true);
  });

  it("フォルダの輪を一件で出す", () => {
    const ds = checkProjectStructure(
      snap({
        folders: [
          { id: "f_a", name: "A", parent: "f_b" },
          { id: "f_b", name: "B", parent: "f_a" },
        ],
      }),
    );
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      code: "folder-cycle",
      subject: { kind: "folder", id: "f_a" },
      related: [{ kind: "folder", id: "f_b" }],
    });
  });

  it("ないフォルダを指す親・置き場所を警告する", () => {
    const ds = checkProjectStructure(
      snap({
        kokostates: [koko("ks", "Gun")],
        folders: [{ id: "f", name: "A", parent: "f_gone" }],
        placement: { ks: "f_gone2" },
      }),
    );
    expect(ds.map((d) => [d.code, d.severity, d.subject.id]).sort()).toEqual([
      ["folder-parent-missing", "warning", "f"],
      ["placement-missing-folder", "warning", "ks"],
    ]);
  });
});

describe("Diagnostic の指紋", () => {
  const base = {
    code: "x",
    severity: "error" as const,
    phase: "authoring" as const,
    provider: "p",
    subject: { kind: "system" as const, id: "s" },
    related: [],
    message: "m",
  };

  it("文言や行番号が変わっても同じ問題は同じ指紋", () => {
    const a = makeDiagnostic({ ...base, location: { kind: "script", line: 3 } });
    const b = makeDiagnostic({
      ...base,
      message: "別の文言",
      location: { kind: "script", line: 9 },
    });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.id).toBe(a.fingerprint);
  });

  it("関係するリソースの並びに左右されず、違う対象なら違う指紋", () => {
    const r1 = { kind: "kokostate" as const, id: "k1" };
    const r2 = { kind: "kokostate" as const, id: "k2" };
    const a = makeDiagnostic({ ...base, location: null, related: [r1, r2] });
    const b = makeDiagnostic({ ...base, location: null, related: [r2, r1] });
    const c = makeDiagnostic({ ...base, location: null, subject: { kind: "system", id: "t" } });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  it("同じ指紋は一つにまとめ、回数を数える", () => {
    const a = makeDiagnostic({ ...base, location: null });
    const out = dedupeDiagnostics([a, { ...a, message: "2回目" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ message: "m", count: 2 });
  });
});

function mat(id: string, name: string) {
  return { id, name, color: "#fff", roughness: 1, metalness: 0 };
}
