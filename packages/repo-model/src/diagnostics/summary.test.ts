import { describe, expect, it } from "vitest";
import { ResourcePathIndex } from "../resourcePath";
import type { ProjectSnapshot } from "../schema";
import { summarizeDiagnostics, summarizeHierarchy } from "./summary";
import { makeDiagnostic } from "./types";

const s: ProjectSnapshot = {
  version: 1,
  name: "p",
  kokostates: [{ id: "ks", name: "Gun", fields: [] }],
  systems: [],
  materials: [{ id: "m", name: "Wood", color: "#fff", roughness: 1, metalness: 0 }],
  outputs: [],
  entities: [],
  folders: [
    { id: "f_top", name: "Art", parent: null },
    { id: "f_sub", name: "Wood", parent: "f_top" },
  ],
  placement: { m: "f_sub", ks: "f_top" },
};
const d = (subject: string, severity: "error" | "warning", related: string[] = []) =>
  makeDiagnostic({
    code: `c${subject}${severity}${related.join()}`,
    severity,
    phase: "authoring",
    provider: "t",
    subject: { kind: subject.startsWith("f") ? "folder" : "material", id: subject },
    location: null,
    related: related.map((id) => ({ kind: "kokostate" as const, id })),
    message: "",
  });

describe("summarizeDiagnostics", () => {
  it("自分の問題と、中（子孫）や関係するものの問題を分けて数える", () => {
    const sum = summarizeDiagnostics(
      [d("m", "error"), d("m", "warning"), d("f_sub", "warning", ["ks"])],
      ResourcePathIndex.fromSnapshot(s),
    );
    expect(sum.get("m")).toEqual({ errors: 1, warnings: 1, nestedErrors: 0, nestedWarnings: 0 });
    expect(sum.get("f_sub")).toEqual({
      errors: 0,
      warnings: 1,
      nestedErrors: 1,
      nestedWarnings: 1,
    });
    expect(sum.get("f_top")).toEqual({
      errors: 0,
      warnings: 0,
      nestedErrors: 1,
      nestedWarnings: 2,
    });
    // 関係するもの（名前の衝突の相手など）は「中」に数える
    expect(sum.get("ks")).toEqual({ errors: 0, warnings: 0, nestedErrors: 0, nestedWarnings: 1 });
  });
});

describe("summarizeHierarchy", () => {
  const entities = [
    { id: "e_root", parent: null, output: "out" },
    { id: "e_child", parent: "e_root", output: "out" },
  ];
  const outputs = [{ id: "out", systems: [{ id: "sys" }] }];
  const at = (
    kind: "entity" | "output" | "system" | "material",
    id: string,
    sev: "error" | "warning",
  ) =>
    makeDiagnostic({
      code: `c${id}${sev}`,
      severity: sev,
      phase: "authoring",
      provider: "t",
      subject: { kind, id },
      location: null,
      related: [],
      message: "",
    });

  it("Entity の問題は自分に、親の Entity とアウトプットには中に数える", () => {
    const sum = summarizeHierarchy([at("entity", "e_child", "error")], entities, outputs);
    expect(sum.get("e_child")).toEqual({
      errors: 1,
      warnings: 0,
      nestedErrors: 0,
      nestedWarnings: 0,
    });
    expect(sum.get("e_root")).toEqual({
      errors: 0,
      warnings: 0,
      nestedErrors: 1,
      nestedWarnings: 0,
    });
    expect(sum.get("out")).toEqual({ errors: 0, warnings: 0, nestedErrors: 1, nestedWarnings: 0 });
  });

  it("System の問題は、使っているアウトプットの中に数える。アウトプット自身の問題は自分に数える", () => {
    const sum = summarizeHierarchy(
      [at("system", "sys", "warning"), at("output", "out", "error")],
      entities,
      outputs,
    );
    expect(sum.get("out")).toEqual({ errors: 1, warnings: 0, nestedErrors: 0, nestedWarnings: 1 });
  });

  it("Hierarchy に関係しない問題と、消えた Entity の問題は数えない", () => {
    const sum = summarizeHierarchy(
      [at("material", "m", "error"), at("entity", "gone", "error")],
      entities,
      outputs,
    );
    expect(sum.size).toBe(0);
  });
});
