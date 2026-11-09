import {
  type DiagnosticView,
  makeDiagnostic,
  type ProjectSnapshot,
  viewDiagnostics,
} from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { runSetsByChanges, trackErrorPrints } from "./problems";

const view = (
  id: string,
  freshness: "current" | "stale",
  severity: "error" | "warning" = "error",
): DiagnosticView => ({
  ...makeDiagnostic({
    code: "x",
    severity,
    phase: "authoring",
    provider: "script",
    subject: { kind: "system", id },
    location: null,
    related: [],
    message: id,
  }),
  freshness,
});

describe("trackErrorPrints", () => {
  it("新しく出た current のエラーを appeared にする", () => {
    const r = trackErrorPrints(new Set(), [view("a", "current")]);
    expect(r.appeared).toEqual([expect.stringContaining("a")]);
    expect(r.known.size).toBe(1);
  });

  it("同じエラーが残っている間は appeared にしない", () => {
    const first = trackErrorPrints(new Set(), [view("a", "current")]);
    const second = trackErrorPrints(first.known, [view("a", "current")]);
    expect(second.appeared).toEqual([]);
  });

  it("stale の間は覚えていて、current に戻っただけでは appeared にしない", () => {
    const first = trackErrorPrints(new Set(), [view("a", "current")]);
    const stale = trackErrorPrints(first.known, [view("a", "stale")]);
    expect(stale.appeared).toEqual([]);
    const back = trackErrorPrints(stale.known, [view("a", "current")]);
    expect(back.appeared).toEqual([]);
  });

  it("消えてから出直したエラーは appeared にする", () => {
    const first = trackErrorPrints(new Set(), [view("a", "current")]);
    const gone = trackErrorPrints(first.known, []);
    expect(gone.known.size).toBe(0);
    const again = trackErrorPrints(gone.known, [view("a", "current")]);
    expect(again.appeared).toHaveLength(1);
  });

  it("注意（warning）と stale のエラーは appeared にしない", () => {
    const r = trackErrorPrints(new Set(), [view("a", "current", "warning"), view("b", "stale")]);
    expect(r.appeared).toEqual([]);
  });
});

describe("runSetsByChanges", () => {
  const snap = (codes: Record<string, string>): ProjectSnapshot => ({
    version: 1,
    name: "p",
    kokostates: [],
    systems: Object.entries(codes).map(([id, code]) => ({ id, name: id, code })),
    materials: [],
    outputs: [],
    entities: [],
  });
  const stopped = (id: string) =>
    makeDiagnostic({
      code: "script-stopped",
      severity: "error",
      phase: "runtime",
      provider: "runtime",
      subject: { kind: "system", id },
      location: { kind: "script", line: 1 },
      related: [],
      message: id,
    });
  const run = { diagnostics: [stopped("a"), stopped("b")], observedVersion: 1 };
  const before = snap({ a: "export default {}", b: "export default {}" });

  it("変更が届いた System の問題だけを古い版のままにし、ほかは今の版にする", () => {
    const after = snap({ a: "export default {}", b: "export default { x: 1 }" });
    const views = viewDiagnostics(runSetsByChanges(run, before, after, 2), 2);
    expect(Object.fromEntries(views.map((v) => [v.subject.id, v.freshness]))).toEqual({
      a: "current",
      b: "stale",
    });
  });

  it("Play を始めたときの版のままなら、そのまま返す", () => {
    expect(runSetsByChanges(run, before, before, 1)).toEqual([run]);
  });
});
