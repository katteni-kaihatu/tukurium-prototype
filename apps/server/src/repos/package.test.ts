import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunAndTargetSample, type ProjectSnapshot } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../store/store";
import { RepoService } from "./service";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const alice = { id: "u_a", name: "a" };
const bob = { id: "u_b", name: "b" };

/** 銃と的を、Gun だけ公開したライブラリにする */
function library(): ProjectSnapshot {
  const s = gunAndTargetSample();
  s.outputs = s.outputs.map((o) => ({ ...o, kind: "library" as const }));
  s.exports = ["ks_gun"];
  return s;
}

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "tk-pkg-"));
  const store = new MemoryStore();
  const repos = new RepoService(store, dir);
  const repo = await repos.create(alice, { name: "武器", snapshot: library() });
  const work = await repos.publish(alice, repo.id, "out_range");
  return { store, repos, repo, work };
}

describe("Library Package（ADR 0015）", () => {
  it("ライブラリの作品をリリースすると、公開分の content hash をサーバーが計算して残す", async () => {
    const { repos, repo, work } = await setup();
    const r1 = await repos.release(alice, work.id);
    expect(r1.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // 公開していないものだけを変えて出し直しても、hash は同じ
    const snap = await repos.snapshot(repo.id);
    snap.materials = snap.materials.map((m) => ({ ...m, color: "#000000" }));
    await repos.commit(repo.id, snap, "色", alice, []);
    const r2 = await repos.release(alice, work.id);
    expect(r2.version).toBe(2);
    expect(r2.contentHash).toBe(r1.contentHash);
  });

  it("版の中身（公開したものだけ）を取り出せる。利用の権限がなければ取り出せない", async () => {
    const { store, repos, work } = await setup();
    await repos.release(alice, work.id);
    const pkg = await repos.packageVersion(bob, work.id, 1);
    expect(pkg).toMatchObject({ packageId: work.id, version: 1 });
    expect(pkg.manifest.exports.map((e) => e.id)).toEqual(["ks_gun"]);
    await store.saveWork({ ...work, perms: { ...work.perms, use: false } });
    await expect(repos.packageVersion(bob, work.id, 1)).rejects.toMatchObject({ status: 403 });
    expect(await repos.packageVersion(alice, work.id, 1)).toMatchObject({ version: 1 });
  });

  it("ライブラリでない作品・無い版は Package として取り出せない", async () => {
    dir = await mkdtemp(join(tmpdir(), "tk-pkg-"));
    const repos = new RepoService(new MemoryStore(), dir);
    const repo = await repos.create(alice, { name: "銃と的", snapshot: gunAndTargetSample() });
    const work = await repos.publish(alice, repo.id, "out_range");
    const rel = await repos.release(alice, work.id);
    expect(rel.contentHash).toBeUndefined();
    await expect(repos.packageVersion(alice, work.id, 1)).rejects.toMatchObject({ status: 404 });
    await expect(repos.packageVersion(alice, "nope", 1)).rejects.toMatchObject({ status: 404 });
  });

  it("依存の中身を、持ち主の許可で取り出す（セッションのホストへ添える）", async () => {
    const { store, repos, work } = await setup();
    const rel = await repos.release(alice, work.id);
    const dep = {
      alias: "arms",
      packageId: work.id,
      version: 1,
      contentHash: rel.contentHash ?? "",
    };
    const ok = await repos.resolveDependencies({ dependencies: [dep] }, bob);
    expect(ok).toMatchObject([{ status: "ready", dependency: dep }]);
    // lock の hash と違えば使わない
    const wrong = await repos.resolveDependencies(
      { dependencies: [{ ...dep, contentHash: "x" }] },
      bob,
    );
    expect(wrong[0]).toMatchObject({ status: "unavailable" });
    // 中身を覚えていても、許可は毎回確かめる
    await store.saveWork({ ...work, perms: { ...work.perms, use: false } });
    const denied = await repos.resolveDependencies({ dependencies: [dep] }, bob);
    expect(denied[0]).toMatchObject({
      status: "unavailable",
      message: expect.stringMatching(/許可/),
    });
    expect(await repos.resolveDependencies({}, bob)).toEqual([]);
  });
});
