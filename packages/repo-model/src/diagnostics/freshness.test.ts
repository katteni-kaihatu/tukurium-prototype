import { describe, expect, it } from "vitest";
import { countCurrent, GenerationGate, viewDiagnostics } from "./freshness";
import { makeDiagnostic } from "./types";

const diag = (
  id: string,
  phase: "authoring" | "runtime" = "authoring",
  severity: "error" | "warning" = "error",
) =>
  makeDiagnostic({
    code: "c",
    severity,
    phase,
    provider: phase === "runtime" ? "runtime" : "script",
    subject: { kind: "system", id },
    location: { kind: "script", line: 1 },
    related: [],
    message: id,
  });

describe("GenerationGate", () => {
  it("最後に始めた検査の結果だけを受け取る（古い結果が後から届いても使わない）", () => {
    const gate = new GenerationGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.accepts(first)).toBe(false);
    expect(gate.accepts(second)).toBe(true);
  });
});

describe("viewDiagnostics", () => {
  it("調べたときの版が今の版と違えば stale にする", () => {
    const views = viewDiagnostics(
      [
        { diagnostics: [diag("a")], observedVersion: 3 },
        { diagnostics: [diag("b", "runtime")], observedVersion: 1 },
      ],
      3,
    );
    expect(views.map((v) => [v.subject.id, v.freshness])).toEqual([
      ["a", "current"],
      ["b", "stale"],
    ]);
  });

  it("同じ問題は一つにまとめ、新しいほうを残す。並びは current → 実行 → エラー の順", () => {
    const views = viewDiagnostics(
      [
        { diagnostics: [diag("a"), diag("w", "authoring", "warning")], observedVersion: 2 },
        {
          diagnostics: [{ ...diag("a"), message: "新しい" }, diag("r", "runtime")],
          observedVersion: 5,
        },
      ],
      5,
    );
    expect(views.map((v) => [v.subject.id, v.message, v.freshness])).toEqual([
      ["r", "r", "current"],
      ["a", "新しい", "current"],
      ["w", "w", "stale"],
    ]);
  });

  it("current のエラー・注意だけを数える（stale は数えない）", () => {
    const views = viewDiagnostics(
      [
        { diagnostics: [diag("a"), diag("w", "authoring", "warning")], observedVersion: 1 },
        { diagnostics: [diag("b")], observedVersion: 0 },
      ],
      1,
    );
    expect(countCurrent(views)).toEqual({ errors: 1, warnings: 1, stale: 1 });
  });
});
