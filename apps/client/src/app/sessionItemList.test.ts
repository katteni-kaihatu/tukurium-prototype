import type { PlacementInfo, WorkspaceInfo } from "@tukurium/shared";
import { describe, expect, it } from "vitest";
import { canPutAway, listedSessionItems, whoPlaced } from "./sessionItemList";

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

const workspace = (patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  id: "ws",
  name: "作業",
  repoId: null,
  host: null,
  defaultRole: "viewer",
  members: [],
  present: [],
  mode: "edit",
  ...patch,
});

describe("左の欄に出すアイテム", () => {
  it("アイテムだけを、並びのまま残す", () => {
    const items = listedSessionItems([
      placed({ id: "gun" }),
      placed({ id: "world", outputKind: "world", outputName: "広場" }),
      placed({ id: "unknown", outputKind: null, outputName: "不明" }),
      placed({ id: "table", outputName: "机" }),
    ]);
    expect(items.map((item) => item.id)).toEqual(["gun", "unknown", "table"]);
  });

  it("持ち主と出した人と、編集できる人が外せる", () => {
    const mine = placed({ id: "a", placedBy: "me" });
    const others = placed({ id: "b", placedBy: "other", workspaceId: "ws" });
    const rooms = [workspace({ members: [{ userId: "ed", role: "editor" }] })];
    expect(canPutAway(mine, "me", "owner", rooms)).toBe(true);
    expect(canPutAway(others, "owner", "owner", rooms)).toBe(true);
    expect(canPutAway(others, "ed", "owner", rooms)).toBe(true);
    expect(canPutAway(others, "guest", "owner", rooms)).toBe(false);
  });

  it("出した人の名前は、自分ならあなた", () => {
    expect(whoPlaced([{ id: "other", name: "花" }], "me", "me")).toBe("あなた");
    expect(whoPlaced([{ id: "other", name: "花" }], "other", "me")).toBe("花");
    expect(whoPlaced([], "gone", "me")).toBe("参加者");
  });
});
