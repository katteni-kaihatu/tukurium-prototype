import type { PlacementInfo, WorkspaceInfo } from "@tukurium/shared";
import { describe, expect, it } from "vitest";
import type { RepoMeta } from "../net/api";
import { canPutAway, itemProjectActions, listedSessionItems, whoPlaced } from "./sessionItemList";

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
  repoId: null,
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

const repo = (patch: Partial<RepoMeta> & Pick<RepoMeta, "id" | "owner">): RepoMeta => ({
  ownerName: "",
  name: patch.id,
  description: "",
  visibility: "public",
  kind: "item",
  forkedFrom: null,
  createdAt: "",
  ...patch,
});

describe("itemProjectActions", () => {
  const source = repo({ id: "r1", owner: "a" });
  const fork = repo({
    id: "r2",
    owner: "me",
    forkedFrom: { repoId: "r1", repoName: "r1", commit: "c" },
  });
  const othersFork = repo({
    id: "r3",
    owner: "b",
    forkedFrom: { repoId: "r1", repoName: "r1", commit: "c" },
  });

  it("持ち主はそのまま開ける", () => {
    const actions = itemProjectActions(placed({ id: "p", repoId: "r1" }), [source], "a");
    expect(actions).toMatchObject({ canOpen: true, canFork: false, forks: [] });
  });

  it("読めるだけならフォークして開く。自分のフォークも並べる", () => {
    const actions = itemProjectActions(
      placed({ id: "p", repoId: "r1" }),
      [source, fork, othersFork],
      "me",
    );
    expect(actions).toMatchObject({ canOpen: false, canFork: true });
    expect(actions?.forks.map((r) => r.id)).toEqual(["r2"]);
  });

  it("元が読めなくても、自分のフォークがあれば開ける", () => {
    const actions = itemProjectActions(placed({ id: "p", repoId: "r1" }), [fork], "me");
    expect(actions).toMatchObject({ source: null, canOpen: false, canFork: false });
    expect(actions?.forks).toHaveLength(1);
  });

  it("元が分からない・読めない・フォークもないなら何もできない", () => {
    expect(itemProjectActions(placed({ id: "p" }), [source], "a")).toBeNull();
    expect(itemProjectActions(placed({ id: "p", repoId: "r9" }), [source], "a")).toBeNull();
  });
});
