import type { PlacementInfo } from "@tukurium/shared";
import { describe, expect, it } from "vitest";
import { currentWorld } from "./openWorld";

const placed = (over: Partial<PlacementInfo> & Pick<PlacementInfo, "id">): PlacementInfo => ({
  workspaceId: null,
  releaseId: null,
  workspaceName: "作品",
  outputId: "out",
  outputName: "名前",
  outputKind: "item",
  position: [0, 0, 0],
  yaw: 0,
  placedBy: "u",
  grants: null,
  ...over,
});

describe("currentWorld", () => {
  it("ワールドがなければ開いていない", () => {
    expect(currentWorld([placed({ id: "a", outputKind: "item" })])).toBeNull();
  });

  it("最初に置いたワールドを、開いているワールドにする", () => {
    const first = placed({ id: "w1", outputKind: "world", outputName: "広場" });
    const second = placed({ id: "w2", outputKind: "world", outputName: "夜" });
    expect(currentWorld([placed({ id: "gun" }), first, second])?.id).toBe("w1");
  });
});
