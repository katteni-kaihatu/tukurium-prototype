import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyProject,
  expandPrefabs,
  gunAndTargetSample,
  OFFICIAL_COMBAT,
  OFFICIAL_PUBLISHER,
  ProjectDoc,
  type ProjectSnapshot,
  packageFieldSchemas,
  packageKokoStates,
  packageResourceId,
  withPackagePrefabs,
} from "@tukurium/repo-model";
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
  s.outputs = s.outputs.map((o) => ({ ...o, kind: "library" as const, resources: ["ks_gun"] }));
  s.entities = [];
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
  it("KokoState だけを公開しても、その型を同名の型がある次のライブラリで保つ", async () => {
    dir = await mkdtemp(join(tmpdir(), "tk-package-state-schema-"));
    const store = new MemoryStore();
    const repos = new RepoService(store, dir);
    const first = new ProjectDoc();
    first.load(emptyProject("型のライブラリ"));
    const counter = first.addKokoState("Counter");
    first.updateKokoState({
      id: counter,
      name: "Counter",
      fields: [
        { id: "ref", name: "ref", type: "KokoStateRef<Counter> | undefined", default: undefined },
      ],
    });
    const firstOutput = first.addOutput("型", "library");
    first.setIncluded(firstOutput, counter, true);
    const firstRepo = await repos.create(alice, { name: "型", snapshot: first.snapshot() });
    const firstWork = await repos.publish(alice, firstRepo.id, firstOutput);
    const firstRelease = await repos.release(alice, firstWork.id);
    const dependency = {
      alias: "types",
      packageId: firstWork.id,
      version: 1,
      contentHash: firstRelease.contentHash as string,
    };
    const firstPackage = await repos.packageVersion(bob, firstWork.id, 1);
    expect(firstPackage.manifest.fieldSchemas?.[counter]?.ref).toMatchObject({
      kind: "union",
      options: [{ kind: "kokoRef", koko: counter }, { kind: "undefined" }],
    });
    const ready = { status: "ready" as const, dependency, manifest: firstPackage.manifest };
    const second = new ProjectDoc();
    second.load(emptyProject("プレハブのライブラリ"));
    second.addDependency(dependency);
    second.setPackageKokoStates(packageKokoStates([ready]));
    second.addKokoState("Counter");
    const prefab = second.addPrefab("的");
    const root = second.prefab(prefab)?.root as string;
    const koko = packageResourceId(dependency, counter);
    second.addState(root, koko, { ref: { entity: root, koko } });
    const secondOutput = second.addOutput("プレハブ", "library");
    second.setIncluded(secondOutput, prefab, true);
    const secondRepo = await repos.create(alice, { name: "プレハブ", snapshot: second.snapshot() });
    const secondWork = await repos.publish(alice, secondRepo.id, secondOutput);
    const secondRelease = await repos.release(alice, secondWork.id);
    const published = await repos.packageVersion(bob, secondWork.id, 1);
    const reopened = new RepoService(store, dir);
    expect((await reopened.packageVersion(bob, secondWork.id, 1)).manifest).toEqual(
      published.manifest,
    );
    const secondDependency = {
      alias: "prefabs",
      packageId: secondWork.id,
      version: 1,
      contentHash: secondRelease.contentHash as string,
    };
    const packages = [
      ready,
      { status: "ready" as const, dependency: secondDependency, manifest: published.manifest },
    ];
    const loaded = withPackagePrefabs(
      {
        ...emptyProject("利用側"),
        dependencies: [secondDependency],
        entities: [
          {
            id: "instance",
            name: "instance",
            output: "out_main",
            parent: null,
            order: 0,
            states: {},
            instanceOf: { prefab: packageResourceId(secondDependency, prefab) },
          },
        ],
      },
      packages,
      undefined,
      true,
    );
    const expanded = expandPrefabs(loaded, { schemas: packageFieldSchemas(packages) });
    expect(expanded.entities[0]?.states[koko]?.ref).toEqual({ entity: "instance", koko });
  });

  it("外部 KokoState が指すローカルのマテリアルを公開し、再起動後も同じ中身を返す", async () => {
    dir = await mkdtemp(join(tmpdir(), "tk-prefab-dependency-"));
    const store = new MemoryStore();
    const repos = new RepoService(store, dir);
    const first = new ProjectDoc();
    first.load(emptyProject("型のライブラリ"));
    const look = first.addKokoState("Look");
    first.updateKokoState({
      id: look,
      name: "Look",
      fields: [{ id: "material", name: "material", type: "MaterialRef", default: "" }],
    });
    const firstOutput = first.addOutput("型", "library");
    first.setIncluded(firstOutput, look, true);
    const firstRepo = await repos.create(alice, { name: "型", snapshot: first.snapshot() });
    const firstWork = await repos.publish(alice, firstRepo.id, firstOutput);
    const firstRelease = await repos.release(alice, firstWork.id);
    const dependency = {
      alias: "types",
      packageId: firstWork.id,
      version: 1,
      contentHash: firstRelease.contentHash as string,
    };
    const firstPackage = await repos.packageVersion(bob, firstWork.id, 1);
    const ready = { status: "ready" as const, dependency, manifest: firstPackage.manifest };
    const second = new ProjectDoc();
    second.load(emptyProject("プレハブのライブラリ"));
    second.addDependency(dependency);
    second.setPackageKokoStates(packageKokoStates([ready]));
    const prefab = second.addPrefab("的");
    const material = second.addMaterial("赤");
    second.addState(second.prefab(prefab)?.root as string, packageResourceId(dependency, look), {
      material,
    });
    const secondOutput = second.addOutput("プレハブ", "library");
    second.setIncluded(secondOutput, prefab, true);
    const secondRepo = await repos.create(alice, { name: "プレハブ", snapshot: second.snapshot() });
    const secondWork = await repos.publish(alice, secondRepo.id, secondOutput);
    const secondRelease = await repos.release(alice, secondWork.id);
    const published = await repos.packageVersion(bob, secondWork.id, 1);
    expect(published.manifest.exports.map((e) => e.id)).toContain(material);
    const reopened = new RepoService(store, dir);
    expect((await reopened.packageVersion(bob, secondWork.id, 1)).manifest).toEqual(
      published.manifest,
    );
    const secondDependency = {
      alias: "prefabs",
      packageId: secondWork.id,
      version: 1,
      contentHash: secondRelease.contentHash as string,
    };
    const loaded = withPackagePrefabs(
      { ...emptyProject("利用側"), dependencies: [secondDependency] },
      [ready, { status: "ready", dependency: secondDependency, manifest: published.manifest }],
    );
    expect(
      loaded.materials.some((m) => m.id === packageResourceId(secondDependency, material)),
    ).toBe(true);
    expect(loaded.prefabEntities?.[0]?.states[packageResourceId(dependency, look)]?.material).toBe(
      packageResourceId(secondDependency, material),
    );
  });

  it("プレハブの中身と参照の型を公開し、古い版の中身を変えない", async () => {
    dir = await mkdtemp(join(tmpdir(), "tk-prefab-pkg-"));
    const store = new MemoryStore();
    const repos = new RepoService(store, dir);
    const p = new ProjectDoc();
    p.load(emptyProject("部品"));
    const koko = p.addKokoState("Target");
    p.updateKokoState({
      id: koko,
      name: "Target",
      fields: [{ id: "targets", name: "targets", type: "EntityRef[]", default: [] }],
    });
    const prefab = p.addPrefab("的");
    const root = p.prefab(prefab)?.root as string;
    p.addState(root, koko, { targets: [root] });
    const output = p.addOutput("部品集", "library");
    p.setIncluded(output, prefab, true);
    const repo = await repos.create(alice, { name: "部品", snapshot: p.snapshot() });
    const work = await repos.publish(alice, repo.id, output);
    const first = await repos.release(alice, work.id);
    const old = await repos.packageVersion(bob, work.id, 1);
    expect(old.manifest.fieldSchemas?.[koko]?.targets).toEqual({
      kind: "list",
      item: { kind: "ref", target: "entity" },
    });
    expect(old.manifest.exports.find((e) => e.kind === "prefab")?.definition).toMatchObject({
      entities: [
        expect.objectContaining({
          states: expect.objectContaining({ [koko]: { targets: [root] } }),
        }),
      ],
    });
    p.setField(root, koko, "targets", []);
    await repos.commit(repo.id, p.snapshot(), "的の参照を変更", alice, []);
    const second = await repos.release(alice, work.id);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect((await repos.packageVersion(bob, work.id, 1)).manifest).toEqual(old.manifest);
    const reopened = new RepoService(store, dir);
    // メモリーのキャッシュだけでなく、保存したコミットからも同じ中身を作れる。
    expect((await reopened.packageVersion(bob, work.id, 1)).manifest).toEqual(old.manifest);
    expect((await reopened.packageVersion(bob, work.id, 2)).manifest.fieldSchemas).toEqual(
      old.manifest.fieldSchemas,
    );
  });

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

  it("依存の依存は、間のライブラリの作者の許可で取り出す。自分に依存するライブラリは出せない", async () => {
    const { store, repos, work: lib1 } = await setup();
    const r1 = await repos.release(alice, lib1.id);
    // Lib1 は誰にも使わせない（持ち主の alice だけ）
    await store.saveWork({ ...lib1, perms: { ...lib1.perms, use: false } });
    const base = {
      alias: "base",
      packageId: lib1.id,
      version: 1,
      contentHash: r1.contentHash ?? "",
    };
    // alice の Lib2 は Lib1 に依存する
    const snap2 = library();
    snap2.dependencies = [base];
    const repo2 = await repos.create(alice, { name: "武器2", snapshot: snap2 });
    const lib2 = await repos.publish(alice, repo2.id, "out_range");
    const r2 = await repos.release(alice, lib2.id);
    const top = {
      alias: "arms",
      packageId: lib2.id,
      version: 1,
      contentHash: r2.contentHash ?? "",
    };

    // bob は Lib1 を直接は使えないが、Lib2 を通してなら届く
    await expect(repos.packageVersion(bob, lib1.id, 1)).rejects.toMatchObject({ status: 403 });
    const pool = await repos.resolveDependencies({ dependencies: [top] }, bob);
    expect(pool.map((r) => [r.dependency.packageId, r.status])).toEqual([
      [lib2.id, "ready"],
      [lib1.id, "ready"],
    ]);
    const pkg = await repos.packageVersion(bob, lib2.id, 1);
    expect(pkg.manifest.dependencies).toEqual([base]);
    expect(pkg.dependencies.map((r) => r.status)).toEqual(["ready"]);

    // Lib1 が Lib2 に依存しようとすると輪になるので、リリースを拒む
    const snap1 = await repos.snapshot(lib1.repoId);
    snap1.dependencies = [top];
    await repos.commit(lib1.repoId, snap1, "輪", alice, []);
    await expect(repos.release(alice, lib1.id)).rejects.toMatchObject({ status: 409 });
  });

  it("フォークしても、依存（lock）と公開の印はそのまま残る", async () => {
    const { repos, repo, work } = await setup();
    const rel = await repos.release(alice, work.id);
    const snap = await repos.snapshot(repo.id);
    const dep = {
      alias: "arms",
      packageId: work.id,
      version: 1,
      contentHash: rel.contentHash ?? "",
    };
    snap.dependencies = [dep];
    await repos.commit(repo.id, snap, "依存", alice, []);
    const fork = await repos.fork(bob, repo.id);
    const forked = await repos.snapshot(fork.id);
    expect(forked.dependencies).toEqual([dep]);
    expect(forked.outputs[0]?.resources).toEqual(["ks_gun"]);
  });

  it("フォークしてもプレハブと中の Entity・参照・維持の印が残る", async () => {
    const { repos, repo } = await setup();
    const snap = await repos.snapshot(repo.id);
    snap.prefabs = [
      {
        id: "pf",
        name: "部品",
        root: "root",
        systems: [{ id: "sys_shoot", enabled: true }],
        keep: [{ entity: "child", koko: "ks_gun", field: "f_ammo" }],
      },
    ];
    snap.prefabEntities = [
      { id: "root", name: "親", prefab: "pf", parent: null, order: 0, states: {} },
      {
        id: "child",
        name: "子",
        prefab: "pf",
        parent: "root",
        order: 0,
        states: { ks_gun: { f_ammo: 3 } },
      },
    ];
    snap.outputs = snap.outputs.map((o) => ({ ...o, resources: ["pf"] }));
    await repos.commit(repo.id, snap, "プレハブ", alice, []);
    const fork = await repos.fork(bob, repo.id);
    const forked = await repos.snapshot(fork.id);
    expect(forked.prefabs).toEqual(snap.prefabs);
    expect(forked.prefabEntities).toEqual(expect.arrayContaining(snap.prefabEntities));
    expect(forked.prefabEntities).toHaveLength(snap.prefabEntities.length);
    expect(forked.outputs[0]?.resources).toEqual(["pf"]);
  });

  it("公式ライブラリを、決まった ID で用意する。何度呼んでも版は増えず、中身が違えば新しい版を出す", async () => {
    dir = await mkdtemp(join(tmpdir(), "tk-pkg-"));
    const store = new MemoryStore();
    const repos = new RepoService(store, dir);
    await repos.ensureOfficialLibraries();
    await repos.ensureOfficialLibraries();
    const id = OFFICIAL_COMBAT.workId;
    const releases = await store.releases(id);
    expect(releases.map((r) => r.version)).toEqual([1]);
    expect((await store.work(id))?.owner).toBe(OFFICIAL_PUBLISHER.id);
    // 誰でも使える。中身は Health と Damageable
    const pkg = await repos.packageVersion(bob, id, 1);
    expect(pkg.manifest.exports.map((e) => e.path)).toEqual(["/Health.koko", "/Damageable.system"]);
    // 最新の版が同梱の中身と違えば（ここでは手で別の中身を出す）、起動のときに同梱の中身を新しい版で出す
    const official = { ...OFFICIAL_PUBLISHER };
    const snap = await repos.snapshot(OFFICIAL_COMBAT.repoId);
    snap.outputs = snap.outputs.map((o) =>
      o.id === OFFICIAL_COMBAT.outputId ? { ...o, resources: [OFFICIAL_COMBAT.health] } : o,
    );
    await repos.commit(OFFICIAL_COMBAT.repoId, snap, "変更", official, []);
    await repos.release(official, id);
    await repos.ensureOfficialLibraries();
    const after = await store.releases(id);
    expect(after.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(after[0]?.contentHash).toBe(releases[0]?.contentHash);
  });
});
