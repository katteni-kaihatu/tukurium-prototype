import { describe, expect, it } from "vitest";
import { PostgresStore } from "./postgres";

// 実際の PostgreSQL で確かめる（TEST_DATABASE_URL があるときだけ。pnpm services:up で起動できる）
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore", () => {
  it("ユーザー・ワークスペース・作業内容を保存して読み出せる", async () => {
    const store = new PostgresStore(url as string);
    await store.init();
    await store.init(); // 2 回呼んでも壊れない
    const key = `misskey:test_${Date.now()}`;
    const user = await store.loginUser({
      key,
      name: "れにうむ",
      account: "@rhenium@misskey.example",
      avatarUrl: null,
    });
    const tokenHash = `h_${Date.now()}`;
    await store.createAuthSession(tokenHash, user.id, Date.now() + 60_000);
    expect((await store.authSession(tokenHash))?.user).toEqual(user);
    expect(await store.authSession("nope")).toBeNull();
    await store.renameUser(user.id, "rhenium");
    // 2 回目のログインでは表示名を変えず、アイコンだけ合わせる
    const again = await store.loginUser({
      key,
      name: "れにうむ",
      account: "@rhenium@misskey.example",
      avatarUrl: "https://misskey.example/a.png",
    });
    expect(again).toMatchObject({ id: user.id, name: "rhenium" });
    await store.deleteAuthSession(tokenHash);
    expect(await store.authSession(tokenHash)).toBeNull();

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
