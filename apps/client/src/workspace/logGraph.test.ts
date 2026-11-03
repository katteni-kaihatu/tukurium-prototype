import { describe, expect, it } from "vitest";
import { layoutLog } from "./logGraph";

describe("layoutLog", () => {
  it("一本の履歴は、同じ列を上から下へつなぐ", () => {
    const rows = layoutLog([
      { oid: "a", parents: ["b"] },
      { oid: "b", parents: ["c"] },
      { oid: "c", parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0]).toMatchObject({ incoming: [false], outgoing: [true], forks: [] });
    expect(rows[1]).toMatchObject({ incoming: [true], outgoing: [true], forks: [] });
    expect(rows[2]).toMatchObject({ incoming: [true], outgoing: [false], forks: [] });
  });

  it("親が 2 人いると、線が分かれてから合流する", () => {
    const rows = layoutLog([
      { oid: "a", parents: ["b", "m"] },
      { oid: "b", parents: ["c"] },
      { oid: "m", parents: ["c"] },
      { oid: "c", parents: [] },
    ]);
    expect(rows[0]).toMatchObject({
      lane: 0,
      incoming: [false, false],
      outgoing: [true, true],
      forks: [1],
    });
    expect(rows[1]).toMatchObject({
      lane: 0,
      incoming: [true, true],
      outgoing: [true, true],
      forks: [],
    });
    expect(rows[2]).toMatchObject({
      lane: 1,
      incoming: [true, true],
      outgoing: [true, false],
      forks: [0],
    });
    expect(rows[3]).toMatchObject({ lane: 0, incoming: [true], outgoing: [false], forks: [] });
  });

  it("履歴が空なら行もない", () => {
    expect(layoutLog([])).toEqual([]);
  });
});
