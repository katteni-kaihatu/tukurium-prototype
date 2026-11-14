import { encodeValue } from "@tukurium/eks";
import type { DebugStop } from "@tukurium/shared";
import { expect, it } from "vitest";
import { debugHoverValue } from "./debugValues";

it("選んだ呼び出しのコピーだけを見せ、Dateも値の形式で見せる", () => {
  const stop: DebugStop = {
    id: "pause",
    systemId: "s",
    entity: null,
    line: 1,
    reason: "test",
    states: [],
    frames: [
      { id: 1, name: "outer", line: 1, variables: [{ name: "value", value: 1, writable: true }] },
      {
        id: 2,
        name: "inner",
        line: 2,
        variables: [
          { name: "value", value: 2, writable: true },
          { name: "date", value: encodeValue(new Date("2026-01-03T00:00:00Z")), writable: true },
        ],
      },
    ],
  };
  expect(debugHoverValue(stop, null, "s", "value")).toBe("2");
  expect(debugHoverValue(stop, 1, "s", "value")).toBe("1");
  expect(debugHoverValue(stop, null, "other", "value")).toBeNull();
  expect(debugHoverValue(null, null, "s", "value")).toBeNull();
  expect(debugHoverValue(stop, null, "s", "date")).toContain('"$t": "Date"');
});
