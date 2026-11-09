import { type Diagnostic, makeDiagnostic, type ProjectSnapshot } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { IncrementalCheck } from "./incrementalCheck";

function snap(
  codes: Record<string, string>,
  extra: Partial<ProjectSnapshot> = {},
): ProjectSnapshot {
  return {
    version: 1,
    name: "p",
    kokostates: [],
    systems: Object.entries(codes).map(([id, code]) => ({ id, name: id, code })),
    materials: [{ id: "m", name: "Wood", color: "#fff", roughness: 1, metalness: 0 }],
    outputs: [],
    entities: [],
    ...extra,
  };
}
const err = (id: string) =>
  makeDiagnostic({
    code: "x",
    severity: "error",
    phase: "authoring",
    provider: "script",
    subject: { kind: "system", id },
    location: { kind: "script", line: 1 },
    related: [],
    message: id,
  });

/** 調べた System を記録し、名前に bad を含む System をエラーにする */
function fakeRun() {
  const calls: string[][] = [];
  const codes = new Map<string, string>();
  const run = async (ids: string[]): Promise<Diagnostic[]> => {
    calls.push([...ids].sort());
    return ids.filter((id) => codes.get(id)?.includes("bad")).map(err);
  };
  return { calls, codes, run };
}

const versions = (c: IncrementalCheck) =>
  Object.fromEntries(c.sets().map((s) => [s.diagnostics[0]?.subject.id ?? "?", s.observedVersion]));

describe("IncrementalCheck", () => {
  it("markAll で、変更がなくてもすべての System を調べ直す。調べ終わるまで前の結果は残る", async () => {
    const f = fakeRun();
    const c = new IncrementalCheck(f.run);
    f.codes.set("a", "bad").set("b", "ok");
    c.update(snap({ a: "bad", b: "ok" }), 1);
    await c.check(1);
    c.markAll();
    expect(versions(c)).toEqual({ a: 1 });
    expect(await c.check(1)).toBe(true);
    expect(f.calls).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(await c.check(1)).toBe(false);
  });

  it("最初は全部の System を調べる", async () => {
    const f = fakeRun();
    const c = new IncrementalCheck(f.run);
    f.codes.set("a", "bad").set("b", "ok");
    c.update(snap({ a: "bad", b: "ok" }), 1);
    expect(await c.check(1)).toBe(true);
    expect(f.calls).toEqual([["a", "b"]]);
    expect(versions(c)).toEqual({ a: 1 });
  });

  it("関係のない変更では System を調べ直さず、結果を今の版のものにする", async () => {
    const f = fakeRun();
    const c = new IncrementalCheck(f.run);
    f.codes.set("a", "bad").set("b", "ok");
    c.update(snap({ a: "bad", b: "ok" }), 1);
    await c.check(1);
    c.update(
      snap(
        { a: "bad", b: "ok" },
        {
          materials: [{ id: "m", name: "Wood", color: "#000", roughness: 1, metalness: 0 }],
        },
      ),
      2,
    );
    expect(versions(c)).toEqual({ a: 2 });
    expect(await c.check(2)).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it("コードを変えた System だけを調べ直し、それまでは前の結果を古い版のまま残す", async () => {
    const f = fakeRun();
    const c = new IncrementalCheck(f.run);
    f.codes.set("a", "bad").set("b", "bad");
    c.update(snap({ a: "bad", b: "bad" }), 1);
    await c.check(1);
    f.codes.set("a", "bad2");
    c.update(snap({ a: "bad2", b: "bad" }), 2);
    expect(versions(c)).toEqual({ a: 1, b: 2 });
    await c.check(2);
    expect(f.calls[1]).toEqual(["a"]);
    expect(versions(c)).toEqual({ a: 2, b: 2 });
  });

  it("消えた System の結果は捨てる", async () => {
    const f = fakeRun();
    const c = new IncrementalCheck(f.run);
    f.codes.set("a", "bad");
    c.update(snap({ a: "bad" }), 1);
    await c.check(1);
    c.update(snap({}), 2);
    expect(c.sets()).toEqual([]);
  });

  it("確認の途中で同じ System がまた変わったら、調べ直しの印を残す（古い結果は使わない）", async () => {
    const f = fakeRun();
    const c = new IncrementalCheck(f.run);
    f.codes.set("a", "bad");
    c.update(snap({ a: "bad" }), 1);
    const first = c.check(1);
    c.update(snap({ a: "bad " }), 2);
    expect(await first).toBe(true);
    expect(versions(c)).toEqual({ a: 1 });
    expect(await c.check(2)).toBe(true);
    expect(versions(c)).toEqual({ a: 2 });
  });

  it("後から始めた確認があれば、先の確認の結果は受け取らない", async () => {
    const f = fakeRun();
    const c = new IncrementalCheck(f.run);
    f.codes.set("a", "bad");
    c.update(snap({ a: "bad" }), 1);
    const first = c.check(1);
    const second = c.check(1);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
  });
});
