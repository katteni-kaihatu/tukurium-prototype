import { describe, expect, it } from "vitest";
import { PostgresStore } from "./postgres";

// 実際の PostgreSQL で確かめる（TEST_DATABASE_URL があるときだけ。pnpm services:up で起動できる）
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore", () => {
  it("ユーザー・ワークスペース・作業内容を保存して読み出せる", async () => {
    const store = new PostgresStore(url as string);
    await store.init();
    await store.init(); // 2 回呼んでも壊れない
    const { user, token } = await store.createUser("れにうむ");
    expect(await store.userByToken(token)).toEqual(user);
    expect(await store.userByToken("nope")).toBeNull();
    await store.renameUser(user.id, "rhenium");
    expect((await store.userByToken(token))?.name).toBe("rhenium");

    const meta = {
      id: `ws_test_${Date.now()}`,
      name: "銃",
      createdBy: user.id,
      defaultRole: "editor" as const,
      members: { [user.id]: "admin" as const },
    };
    await store.saveWorkspace(meta);
    expect(await store.workspace(meta.id)).toEqual(meta);
    await store.saveWorkspace({ ...meta, defaultRole: null });
    expect((await store.workspace(meta.id))?.defaultRole).toBeNull();
    expect(await store.loadDoc(meta.id)).toBeNull();
    await store.saveDoc(meta.id, new Uint8Array([1, 2, 3]));
    expect(Array.from((await store.loadDoc(meta.id)) ?? [])).toEqual([1, 2, 3]);
    expect(await store.user(user.id)).toMatchObject({ id: user.id });

    const repo = {
      id: `r_test_${Date.now()}`,
      owner: user.id,
      name: "銃",
      description: "",
      visibility: "public" as const,
      kind: "item",
      forkedFrom: null,
      createdAt: new Date().toISOString(),
    };
    await store.saveRepo(repo);
    expect(await store.repo(repo.id)).toEqual(repo);
    expect((await store.repos({ owner: user.id })).map((r) => r.id)).toContain(repo.id);
    const work = {
      id: `w_test_${Date.now()}`,
      repoId: repo.id,
      outputId: "out",
      name: "銃",
      owner: user.id,
      perms: { use: true, view: true, fork: true },
      createdAt: new Date().toISOString(),
    };
    await store.saveWork(work);
    expect(await store.works({ repoId: repo.id })).toEqual([work]);
    const rel = {
      id: `rel_test_${Date.now()}`,
      workId: work.id,
      version: 1,
      commit: "abc",
      createdAt: work.createdAt,
    };
    await store.saveRelease(rel);
    expect(await store.releases(work.id)).toEqual([rel]);
    expect(await store.release(rel.id)).toEqual(rel);
    await store.close();
  });
});
