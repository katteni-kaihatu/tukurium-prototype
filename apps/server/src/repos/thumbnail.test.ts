import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunAndTargetSample, type ProjectSnapshot } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { Hub } from "../hub";
import { MemoryStore } from "../store/store";
import { ItemCatalog } from "./catalog";
import { RepoService } from "./service";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const alice = { id: "u_a", name: "a" };
const bob = { id: "u_b", name: "b" };
const IMG = "a".repeat(64);

/** サムネイルを付けた、非公開のリポジトリ（利用だけ許す作品にする） */
async function setup() {
  dir = await mkdtemp(join(tmpdir(), "tk-thumb-"));
  const store = new MemoryStore();
  const repos = new RepoService(store, dir);
  const snap: ProjectSnapshot = gunAndTargetSample();
  snap.assets = [{ id: IMG, name: "射撃場 のサムネイル", kind: "image", contentType: "image/png" }];
  snap.outputs = snap.outputs.map((o) => ({ ...o, thumbnail: IMG }));
  const repo = await repos.create(alice, { name: "銃と的", snapshot: snap, visibility: "private" });
  const work = await repos.publish(alice, repo.id, "out_range");
  await store.saveWork({ ...work, perms: { use: true, view: false, fork: false } });
  return { store, repos, repo, work };
}

describe("アウトプットのサムネイル（ADR 0046）", () => {
  it("作品の情報に、リリースした版のサムネイルが入る（リリース前は入らない）", async () => {
    const { store, repos, work } = await setup();
    const catalog = new ItemCatalog(store, repos);
    expect((await catalog.describe(work)).thumbnail).toBeNull();
    await repos.release(alice, work.id);
    expect((await catalog.describe((await store.work(work.id)) ?? work)).thumbnail).toBe(IMG);
  });

  it("リリースした作品のサムネイルは、元データを見られない人も取り出せる", async () => {
    const { store, repos, work } = await setup();
    const hub = new Hub(store, { repos });
    // 非公開で、閲覧の許可もないので、まだ見られない
    expect(await hub.canSeeAssetInRepos(bob, IMG)).toBe(false);
    await repos.release(alice, work.id);
    expect(await hub.canSeeAssetInRepos(bob, IMG)).toBe(true);
    // サムネイルでない素材は見せない
    expect(await hub.canSeeAssetInRepos(bob, "b".repeat(64))).toBe(false);
  });
});
