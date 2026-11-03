import type { PlacementInfo } from "@tukurium/shared";
import { describe, expect, it } from "vitest";
import { type BelongingSession, canManagePlacement, listBelongings } from "./belongings";

const session: BelongingSession = {
  owner: "owner",
  workspaces: [
    {
      id: "ws",
      defaultRole: "editor",
      members: [{ userId: "viewer", role: "viewer" }],
    },
  ],
};

const placed = (
  over: Partial<PlacementInfo> & Pick<PlacementInfo, "id" | "outputName">,
): PlacementInfo => ({
  workspaceId: "ws",
  releaseId: null,
  workspaceName: "銃と的",
  outputId: "out",
  position: [1.25, 0, -2],
  yaw: 0,
  placedBy: "owner",
  ...over,
});

describe("listBelongings", () => {
  it("セッションに置いたものを、出した元と位置つきで並べる", () => {
    const rows = listBelongings(
      [
        placed({ id: "a", outputName: "銃" }),
        placed({
          id: "b",
          outputName: "的",
          releaseId: "rel",
          workspaceId: null,
          workspaceName: "射撃場 v1",
          placedBy: "guest",
        }),
      ],
      session,
      "owner",
      new Map([["guest", "かかお"]]),
    );
    expect(rows.map((r) => r.title)).toEqual(["銃", "的"]);
    expect(rows[0]).toMatchObject({
      from: "銃と的",
      published: false,
      position: "1.3, 0.0, -2.0",
      by: "あなた",
      canManage: true,
    });
    expect(rows[1]).toMatchObject({
      from: "公開された作品 · 射撃場 v1",
      published: true,
      by: "かかお",
      canManage: true,
    });
  });

  it("同じアウトプットを複数置いたときだけ番号を付ける", () => {
    const rows = listBelongings(
      [
        placed({ id: "a", outputName: "銃" }),
        placed({ id: "b", outputName: "的", outputId: "target" }),
        placed({ id: "c", outputName: "銃" }),
      ],
      session,
      null,
      new Map(),
    );
    expect(rows.map((r) => r.title)).toEqual(["銃 #1", "的", "銃 #2"]);
    expect(rows.every((r) => !r.canManage)).toBe(true);
  });

  it("別のワークスペースの同じアウトプットは、別の番号にする", () => {
    const rows = listBelongings(
      [
        placed({ id: "a", outputName: "銃", workspaceId: "ws" }),
        placed({ id: "b", outputName: "銃", workspaceId: "other", workspaceName: "別" }),
      ],
      session,
      "owner",
      new Map(),
    );
    expect(rows.map((r) => [r.title, r.from])).toEqual([
      ["銃", "銃と的"],
      ["銃", "別"],
    ]);
  });
});

describe("canManagePlacement", () => {
  const item = placed({ id: "a", outputName: "銃", placedBy: "guest" });

  it("セッションの持ち主と、置いた人は操作できる", () => {
    expect(canManagePlacement(item, session, "owner")).toBe(true);
    expect(canManagePlacement(item, session, "guest")).toBe(true);
  });

  it("元のワークスペースの共同編集者は操作でき、閲覧者はできない", () => {
    expect(canManagePlacement(item, session, "editor")).toBe(true);
    expect(canManagePlacement(item, session, "viewer")).toBe(false);
  });

  it("公開された作品は、持ち主と置いた人だけが操作できる", () => {
    const published = placed({
      id: "p",
      outputName: "的",
      workspaceId: null,
      releaseId: "rel",
      placedBy: "guest",
    });
    expect(canManagePlacement(published, session, "owner")).toBe(true);
    expect(canManagePlacement(published, session, "guest")).toBe(true);
    expect(canManagePlacement(published, session, "editor")).toBe(false);
  });

  it("元のワークスペースがセッションに無いときは、持ち主と置いた人だけ", () => {
    const orphan = placed({
      id: "o",
      outputName: "銃",
      workspaceId: "gone",
      placedBy: "guest",
    });
    expect(canManagePlacement(orphan, session, "editor")).toBe(false);
    expect(canManagePlacement(orphan, session, "guest")).toBe(true);
  });
});
