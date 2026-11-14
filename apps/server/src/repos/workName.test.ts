import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunAndTargetSample } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../store/store";
import { ItemCatalog } from "./catalog";
import { RepoService } from "./service";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const alice = { id: "u_a", name: "a" };

describe("作品の名前（ADR 0077）", () => {
  it("マーケットで公開中の版のアウトプットの名前を出す。登録していなければ最新の版の名前", async () => {
    dir = await mkdtemp(join(tmpdir(), "tk-name-"));
    const store = new MemoryStore();
    const repos = new RepoService(store, dir);
    const catalog = new ItemCatalog(store, repos);
    const repo = await repos.create(alice, { name: "銃と的", snapshot: gunAndTargetSample() });
    const work = await repos.publish(alice, repo.id, "out_range");
    const v1 = await repos.release(alice, work.id);
    const before = (await catalog.describe(work)).name;
    await catalog.register(alice, work.id, { price: 0, autoPublish: false, releaseId: v1.id });

    // アウトプットの名前を変えて保存し、新しい版を出す
    const snap = await repos.snapshot(repo.id);
    snap.outputs = snap.outputs.map((o) =>
      o.id === "out_range" ? { ...o, name: "新しい名前" } : o,
    );
    await repos.commit(repo.id, snap, "名前を変える", alice, []);
    const v2 = await repos.release(alice, work.id);

    // マーケットはまだ v1 を公開しているので、名前は変わらない
    expect((await catalog.describe(work)).name).toBe(before);
    expect((await catalog.search(null, "", 0, 24)).items[0]?.name).toBe(before);

    // 公開する版を v2 にすると、名前も変わる
    await catalog.editListing(alice, work.id, { releaseId: v2.id });
    expect((await catalog.describe(work)).name).toBe("新しい名前");
    expect((await catalog.search(null, "新しい", 0, 24)).total).toBe(1);

    // 登録をやめると、最新の版の名前
    await catalog.unlist(alice, work.id);
    expect((await catalog.describe(work)).name).toBe("新しい名前");
  });
});
