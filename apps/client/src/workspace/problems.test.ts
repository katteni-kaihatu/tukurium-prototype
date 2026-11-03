import { type DiagnosticView, makeDiagnostic } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { trackErrorPrints } from "./problems";

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
