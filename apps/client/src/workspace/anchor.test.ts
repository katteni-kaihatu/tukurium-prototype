import type { WorkspaceInfo } from "@tukurium/shared";
import { describe, expect, it } from "vitest";
import {
  ARRIVAL_OFFSET,
  EXIT_BEHIND_ARRIVAL,
  exitPortalAt,
  PORTAL_RADIUS,
  prefabAnchor,
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
      prefabAnchor([workspace("w", "editor")], "w"),
    ]) {
      expect(anchor.isolated).toBe(true);
      const exit = exitPortalAt(anchor.position);
      const dist = Math.hypot(exit[0] - anchor.portal[0], exit[2] - anchor.portal[2]);
      expect(dist).toBeGreaterThan(100);
    }
  });
});

describe("プレハブを離れた空間で編集するときの置き場所", () => {
  it("区画とポータルは、ワークスペースのもの。空間は、ワールド・非公開の作業と重ならない", () => {
    const list = [workspace("a", "editor"), workspace("w", "editor"), workspace("p", null)];
    for (const id of ["a", "w", "p"]) {
      const prefab = prefabAnchor(list, id);
      const world = workspaceAnchor(list, id, "world");
      expect(prefab.isolated).toBe(true);
      expect(prefab.slot).toEqual(world.slot);
      expect(prefab.portal).toEqual(world.portal);
      // ほかのどのワークスペースの空間（アイテム・ワールド・非公開）からも、100 m より離れている
      for (const other of list)
        for (const kind of ["item", "world"] as const) {
          const at = workspaceAnchor(list, other.id, kind).position;
          const dist = Math.hypot(prefab.position[0] - at[0], prefab.position[2] - at[2]);
          expect(dist).toBeGreaterThan(100);
        }
    }
    // ワークスペースごとに、別の場所
    expect(prefabAnchor(list, "a").position).not.toEqual(prefabAnchor(list, "w").position);
  });
});
