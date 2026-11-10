import type { WorkspaceInfo } from "@tukurium/shared";
import { describe, expect, it } from "vitest";
import {
  ARRIVAL_OFFSET,
  EXIT_BEHIND_ARRIVAL,
  exitPortalAt,
  PORTAL_RADIUS,
  workspaceAnchor,
} from "./anchor";

function workspace(id: string, role: WorkspaceInfo["defaultRole"]): WorkspaceInfo {
  return {
    id,
    name: id,
    repoId: null,
    host: null,
    defaultRole: role,
    members: [],
    present: [],
    mode: "edit",
  };
}

describe("独立した空間の出口", () => {
  it("着いた位置の奥にあり、着いた直後には触れない", () => {
    const anchor = workspaceAnchor([workspace("w", "editor")], "w", "world");
    const exit = exitPortalAt(anchor.position);
    expect(exit[0]).toBe(anchor.position[0]);
    expect(exit[2] - (anchor.position[2] + ARRIVAL_OFFSET)).toBe(EXIT_BEHIND_ARRIVAL);
    expect(EXIT_BEHIND_ARRIVAL).toBeGreaterThan(PORTAL_RADIUS);
  });

  it("セッションへ戻った着地地点は、入り口に触れない", () => {
    const anchor = workspaceAnchor([workspace("w", "editor")], "w", "world");
    const dist = Math.abs(anchor.slot[2] + ARRIVAL_OFFSET - anchor.portal[2]);
    expect(dist).toBeGreaterThan(PORTAL_RADIUS);
  });

  it("入り口と出口は、歩いて行き来できないほど離れている", () => {
    for (const anchor of [
      workspaceAnchor([workspace("w", "editor")], "w", "world"),
      workspaceAnchor([workspace("p", null)], "p", "item"),
    ]) {
      expect(anchor.isolated).toBe(true);
      const exit = exitPortalAt(anchor.position);
      const dist = Math.hypot(exit[0] - anchor.portal[0], exit[2] - anchor.portal[2]);
      expect(dist).toBeGreaterThan(100);
    }
  });
});
