import type { PlacementInfo } from "@tukurium/shared";
import { describe, expect, it } from "vitest";
import type { OwnedItem } from "../net/api";
import { sessionItemGroups } from "./sessionItems";

const owned = (workId: string, releaseId: string) =>
  ({ workId, releaseId, available: true, acquiredAt: "2026-11-05T00:00:00Z" }) as OwnedItem;

const placed = (patch: Partial<PlacementInfo> & Pick<PlacementInfo, "id">): PlacementInfo => ({
  workspaceId: null,
  releaseId: null,
  workspaceName: "作品",
  outputId: "out",
  outputName: "銃",
  outputKind: "item",
  position: [0, 0, 0],
  yaw: 0,
  placedBy: "u",
  grants: null,
  ...patch,
});

describe("セッションに出ているアイテムの一覧", () => {
  const items = [owned("gun", "rel_gun"), owned("table", "rel_table")];

  it("見えている所持品のカードに、同じ版の配置をまとめる", () => {
    const groups = sessionItemGroups(
      items,
      [
        placed({ id: "a", releaseId: "rel_gun" }),
        placed({ id: "b", releaseId: "rel_gun", outputName: "銃" }),
        placed({ id: "w", outputKind: "world", outputName: "広場" }),
      ],
      new Set(["gun", "table"]),
    );
    expect(groups.onCards.get("gun")?.map((p) => p.id)).toEqual(["a", "b"]);
    expect(groups.onCards.has("table")).toBe(false);
    expect(groups.extra).toEqual([]);
  });

  it("絞り込みで隠れている所持品と、ワークスペースから出したものは別に出す", () => {
    const groups = sessionItemGroups(
      items,
      [
        placed({ id: "hidden", releaseId: "rel_table" }),
        placed({ id: "workspace", workspaceId: "ws", releaseId: null, workspaceName: "作業" }),
      ],
      new Set(["gun"]),
    );
    expect(groups.onCards.size).toBe(0);
    expect(groups.extra.map((entry) => [entry.placement.id, entry.item?.workId ?? null])).toEqual([
      ["hidden", "table"],
      ["workspace", null],
    ]);
  });
});
