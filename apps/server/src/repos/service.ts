import { createHash, randomUUID } from "node:crypto";
import {
  type ExtractSelection,
  extractInto,
  fromFiles,
  lockKey,
  OFFICIAL_PUBLISHER,
  officialLibraries,
  type PackageDependency,
  type PackageManifest,
  type PackageResolution,
  type ProjectSnapshot,
  packageManifest,
  stableStringify,
  toFiles,
} from "@tukurium/repo-model";
import { workTagsSchema } from "@tukurium/shared";
import type { Release, RepoMeta, Store, User, Work, WorkPerms } from "../store/store";
import { type Author, GitStore } from "./gitStore";

/** 公開したものの content hash。並べ方を決めた JSON の sha256（ADR 0013 §2） */
export const contentHashOf = (manifest: PackageManifest) =>
  createHash("sha256").update(stableStringify(manifest)).digest("hex");

const shortId = (p: string) => `${p}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * リポジトリ・作品・リリースの操作と権限（ADR 0007）。
 * - リポジトリは公開（既定）なら誰でも見られ、フォーク・抽出できる。非公開なら持ち主だけ。
 * - 作品の権限（利用・元データ閲覧・フォーク／抽出）は、非公開のリポジトリでも、その作品を通して許可を与える。
 */
export class RepoService {
  readonly git: GitStore;
  /** リリース ID → その版の中身（版は書き換えないので覚えておける。許可は毎回確かめる） */
  private readonly manifests = new Map<string, PackageManifest>();
  private readonly repoOperations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    gitRoot: string,
  ) {
    this.git = new GitStore(gitRoot);
  }

  /** 編集を開く操作と既存先への抽出を、同じリポジトリでは順番に処理する。 */
  async withRepoLock<T>(repoId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.repoOperations.get(repoId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    this.repoOperations.set(repoId, current);
    try {
      return await current;
    } finally {
      if (this.repoOperations.get(repoId) === current) this.repoOperations.delete(repoId);
    }
  }

  async require(repoId: string): Promise<RepoMeta> {
    const r = await this.store.repo(repoId);
    if (!r) throw new HttpError(404, "リポジトリが見つかりません");
    return r;
  }

  private async workPerm(repoId: string, key: keyof WorkPerms): Promise<boolean> {
    return (await this.store.works({ repoId })).some((w) => w.perms[key]);
  }

  async canRead(user: User | null, repo: RepoMeta): Promise<boolean> {
    return (
      repo.visibility === "public" || repo.owner === user?.id || this.workPerm(repo.id, "view")
    );
  }

  async canFork(user: User | null, repo: RepoMeta): Promise<boolean> {
    if (!user) return false;
    return repo.visibility === "public" || repo.owner === user.id || this.workPerm(repo.id, "fork");
  }

  async readable(user: User | null, repoId: string): Promise<RepoMeta> {
    const repo = await this.require(repoId);
    if (!(await this.canRead(user, repo))) throw new HttpError(404, "リポジトリが見つかりません");
    return repo;
  }

  async create(
    owner: User,
    init: {
      name: string;
      description?: string;
      kind?: string;
      visibility?: "public" | "private";
      snapshot: ProjectSnapshot;
      /** 決まった ID で作る（公式ライブラリ）。ふつうは振る */
      id?: string;
    },
    forkedFrom: RepoMeta["forkedFrom"] = null,
  ): Promise<RepoMeta> {
    const meta: RepoMeta = {
      id: init.id ?? shortId("r"),
      owner: owner.id,
      name: init.name.trim().slice(0, 64) || "untitled",
      description: (init.description ?? "").slice(0, 300),
      visibility: init.visibility ?? "public",
      kind: init.kind ?? "item",
      forkedFrom,
      createdAt: new Date().toISOString(),
    };
    await this.git.init(meta.id);
    await this.git.commit(
      meta.id,
      toFiles({ ...init.snapshot, name: meta.name }),
      "最初のコミット",
      owner,
    );
    await this.store.saveRepo(meta);
    return meta;
  }

  async snapshot(repoId: string, commit?: string): Promise<ProjectSnapshot> {
    return fromFiles(await this.git.files(repoId, commit));
  }

  async commit(
    repoId: string,
    snap: ProjectSnapshot,
    message: string,
    author: Author,
    coAuthors: Author[],
  ) {
    return this.git.commit(
      repoId,
      toFiles(snap),
      message || "（メッセージなし）",
      author,
      coAuthors,
    );
  }

  async fork(user: User, repoId: string, name?: string): Promise<RepoMeta> {
    const src = await this.require(repoId);
    if (!(await this.canFork(user, src))) throw new HttpError(403, "フォークする権限がありません");
    const head = await this.git.head(repoId);
    if (!head) throw new HttpError(409, "まだコミットがありません");
    const meta: RepoMeta = {
      id: shortId("r"),
      owner: user.id,
      name: (name ?? src.name).slice(0, 64),
      description: src.description,
      visibility: "public",
      kind: src.kind,
      forkedFrom: { repoId: src.id, repoName: src.name, commit: head },
      createdAt: new Date().toISOString(),
    };
    await this.git.fork(src.id, meta.id);
    // 由来を記録するコミット
    const snap = await this.snapshot(meta.id);
    snap.provenance = [
      ...(snap.provenance ?? []),
      {
        kind: "fork",
        repoId: src.id,
        repoName: src.name,
        commit: head,
        items: [],
        at: meta.createdAt,
      },
    ];
    await this.commit(meta.id, { ...snap, name: meta.name }, `${src.name} からフォーク`, user, []);
    await this.store.saveRepo(meta);
    return meta;
  }

  /**
   * 開いているワークスペースへ取り込むための、取り出し元の中身（いまの最新のコミット）。
   * 抽出と同じく、フォークできる人だけに渡す（見るだけの人には渡さない）。
   */
  async importSource(
    user: User,
    repoId: string,
  ): Promise<{ repoId: string; repoName: string; commit: string; snapshot: ProjectSnapshot }> {
    const src = await this.require(repoId);
    if (!(await this.canFork(user, src))) throw new HttpError(403, "取り込む権限がありません");
    const commit = await this.git.head(repoId);
    if (!commit) throw new HttpError(409, "まだコミットがありません");
    return {
      repoId: src.id,
      repoName: src.name,
      commit,
      snapshot: await this.snapshot(repoId, commit),
    };
  }

  /** 抽出：新しいリポジトリ（target.name）か、自分の既存のリポジトリ（target.repoId）へ */
  async extract(
    user: User,
    repoId: string,
    selection: ExtractSelection,
    target: { name: string } | { repoId: string },
    commit?: string,
  ): Promise<{ repo: RepoMeta; commit: string }> {
    const src = await this.require(repoId);
    if (!(await this.canFork(user, src))) throw new HttpError(403, "抽出する権限がありません");
    const at = commit ?? (await this.git.head(repoId));
    if (!at) throw new HttpError(409, "まだコミットがありません");
    const snap = await this.snapshot(repoId, at);
    const source = { repoId: src.id, repoName: src.name, commit: at };
    if ("repoId" in target) {
      return this.withRepoLock(target.repoId, async () => {
        const dst = await this.require(target.repoId);
        if (dst.owner !== user.id)
          throw new HttpError(403, "取り込み先は自分のリポジトリにしてください");
        const workspaceId = `w_${dst.id}`;
        if ((await this.store.workspace(workspaceId)) || (await this.store.loadDoc(workspaceId)))
          throw new HttpError(
            409,
            "このプロジェクトには編集用のデータがあります。新しいプロジェクトへ抽出してください",
          );
        const merged = extractInto(snap, selection, source, await this.snapshot(dst.id));
        const oid = await this.commit(dst.id, merged, `${src.name} から抽出して取り込み`, user, []);
        return { repo: dst, commit: oid };
      });
    }
    const extracted = extractInto(snap, selection, source, null, target.name);
    const repo = await this.create(user, { name: target.name, snapshot: extracted });
    return { repo, commit: (await this.git.head(repo.id)) as string };
  }

  async publish(
    user: User,
    repoId: string,
    outputId: string,
    name?: string,
    tags: string[] = [],
  ): Promise<Work> {
    const repo = await this.require(repoId);
    if (repo.owner !== user.id)
      throw new HttpError(403, "作品として公開できるのはリポジトリの持ち主です");
    const snap = await this.snapshot(repoId);
    const output = snap.outputs.find((o) => o.id === outputId);
    if (!output)
      throw new HttpError(404, "アウトプットが見つかりません（コミットしてから公開してください）");
    const existing = (await this.store.works({ repoId })).find((w) => w.outputId === outputId);
    if (existing) return existing;
    const work: Work = {
      id: shortId("w"),
      repoId,
      outputId,
      name: name ?? output.name,
      owner: user.id,
      tags: workTagsSchema.parse(tags),
      perms: { use: true, view: true, fork: true },
      createdAt: new Date().toISOString(),
    };
    await this.store.saveWork(work);
    return work;
  }

  async release(user: User, workId: string, commit?: string): Promise<Release> {
    const work = await this.store.work(workId);
    if (!work) throw new HttpError(404, "作品が見つかりません");
    if (work.owner !== user.id) throw new HttpError(403, "リリースできるのは作品の持ち主です");
    const at = commit ?? (await this.git.head(work.repoId));
    if (!at) throw new HttpError(409, "まだコミットがありません");
    const snap = await this.snapshot(work.repoId, at);
    if (!snap.outputs.some((o) => o.id === work.outputId)) {
      throw new HttpError(409, "このコミットには作品のアウトプットがありません");
    }
    const output = snap.outputs.find((o) => o.id === work.outputId);
    // ライブラリが（依存の依存を通してでも）自分自身に依存していたら、輪になるので出さない
    if (output?.kind === "library") {
      const pool = await this.resolveDependencies(snap, user, [workId]);
      if (pool.some((r) => r.status === "unavailable" && r.message === CYCLE))
        throw new HttpError(409, `このライブラリは自分自身に依存しています（${CYCLE}）`);
    }
    const prev = await this.store.releases(workId);
    const version = (prev[0]?.version ?? 0) + 1;
    const contentHash =
      output?.kind === "library" ? contentHashOf(packageManifest(snap)) : undefined;
    // 版は書き換えない：同じ版がもう違う中身で出ていたら拒む（同時に出したとき）
    const same = prev.find((p) => p.version === version);
    if (same && same.contentHash !== contentHash)
      throw new HttpError(409, `版 ${version} はもう別の中身で出ています`);
    const r: Release = {
      id: shortId("rel"),
      workId,
      version,
      commit: at,
      createdAt: new Date().toISOString(),
      ...(contentHash ? { contentHash } : {}),
    };
    await this.store.saveRelease(r);
    return r;
  }

  /**
   * 同梱の公式ライブラリを、公式の発行者の作品として用意する（起動のときに呼ぶ。ADR 0016）。
   * リポジトリ・作品の ID は決まった値。中身が最新の版と違えば（または版がなければ）コミットして新しい版を出す。
   * 出した版は書き換えない。
   */
  async ensureOfficialLibraries(): Promise<void> {
    const publisher: User = { ...OFFICIAL_PUBLISHER };
    await this.store.ensureUser(publisher);
    for (const lib of officialLibraries()) {
      const created = !(await this.store.repo(lib.repoId));
      if (created)
        await this.create(publisher, {
          id: lib.repoId,
          name: lib.name,
          description: lib.description,
          kind: "library",
          snapshot: lib.snapshot,
        });
      const work = await this.store.work(lib.workId);
      if (!work)
        await this.store.saveWork({
          id: lib.workId,
          repoId: lib.repoId,
          outputId: lib.outputId,
          name: lib.name,
          owner: publisher.id,
          perms: { use: true, view: true, fork: true },
          createdAt: new Date().toISOString(),
        });
      const latest = (await this.store.releases(lib.workId))[0];
      // 公開した中身（hash）とサムネイル（ADR 0046。中身の hash には入らない）が同じなら、出し直さない
      const thumbnail = (snap: ProjectSnapshot | null) =>
        snap?.outputs.find((o) => o.id === lib.outputId)?.thumbnail ?? null;
      const released = latest
        ? await this.snapshot(lib.repoId, latest.commit).catch(() => null)
        : null;
      if (
        latest?.contentHash === contentHashOf(packageManifest(lib.snapshot)) &&
        thumbnail(released) === thumbnail(lib.snapshot)
      )
        continue;
      // 作ったばかりなら、最初のコミットが同梱の中身。そうでなければ、同梱の中身をコミットしてから出す
      if (!created)
        await this.commit(lib.repoId, lib.snapshot, "公式ライブラリを更新", publisher, []);
      await this.release(publisher, lib.workId);
    }
  }

  /**
   * ライブラリの版の中身（公開したものだけ）。作品の「利用」が許されていれば誰でも取り出せる
   * （持ち主はいつでも）。hash はリリースのときに残したものを返し、取り出すたびに確かめる。
   * 依存の依存も、そのライブラリの作者の許可で取り出して添える。
   */
  async packageVersion(
    user: Pick<User, "id"> | null,
    workId: string,
    version: number,
  ): Promise<{
    packageId: string;
    version: number;
    contentHash: string;
    manifest: PackageManifest;
    /** 依存の依存（間のライブラリの作者の許可で取り出したもの。lock ごとに一つ） */
    dependencies: PackageResolution[];
  }> {
    const got = await this.loadPackage(user, workId, version);
    const dependencies = dedupe(
      await this.resolveDependencies(got.manifest, { id: got.owner }, [workId]),
    );
    return {
      packageId: workId,
      version,
      contentHash: got.contentHash,
      manifest: got.manifest,
      dependencies,
    };
  }

  /** 版の中身を取り出す（許可は毎回確かめる。中身はリリースごとに覚える） */
  private async loadPackage(
    user: Pick<User, "id"> | null,
    workId: string,
    version: number,
  ): Promise<{ owner: string; contentHash: string; manifest: PackageManifest }> {
    const work = await this.store.work(workId);
    if (!work) throw new HttpError(404, "作品が見つかりません");
    if (!work.perms.use && work.owner !== user?.id)
      throw new HttpError(403, "このライブラリを使う許可がありません");
    const rel = (await this.store.releases(workId)).find((r) => r.version === version);
    if (!rel?.contentHash) throw new HttpError(404, "ライブラリの版が見つかりません");
    let manifest = this.manifests.get(rel.id);
    if (!manifest) {
      manifest = packageManifest(await this.snapshot(work.repoId, rel.commit));
      if (contentHashOf(manifest) !== rel.contentHash)
        throw new HttpError(500, "ライブラリの中身が、出したときと一致しません");
      this.manifests.set(rel.id, manifest);
    }
    return { owner: work.owner, contentHash: rel.contentHash, manifest };
  }

  /**
   * 依存の中身を、依存の依存までたどって取り出す（ADR 0015）。直接の依存は viewer（リポジトリの持ち主）の許可、
   * 依存の依存は、それを依存に書いたライブラリの作者の許可で取り出す（利用者と決めた）。
   * セッションのホストへ配置と一緒に渡す。取り出せない依存・lock と hash が違う依存・輪になった依存は、
   * 理由つきで使えないものにする。`path` はたどってきた Package ID（輪の検出に使う）。
   */
  async resolveDependencies(
    snap: { dependencies?: PackageDependency[] },
    viewer: Pick<User, "id"> | null,
    path: string[] = [],
  ): Promise<PackageResolution[]> {
    const lists = await Promise.all(
      (snap.dependencies ?? []).map(async (dependency): Promise<PackageResolution[]> => {
        if (path.includes(dependency.packageId))
          return [{ status: "unavailable", dependency, message: CYCLE }];
        if (path.length >= MAX_DEPTH)
          return [{ status: "unavailable", dependency, message: "依存が深すぎます" }];
        try {
          const got = await this.loadPackage(viewer, dependency.packageId, dependency.version);
          if (got.contentHash !== dependency.contentHash)
            return [
              {
                status: "unavailable",
                dependency,
                message: `v${dependency.version} の中身が、足したときと違います`,
              },
            ];
          const below = await this.resolveDependencies(got.manifest, { id: got.owner }, [
            ...path,
            dependency.packageId,
          ]);
          return [{ status: "ready", dependency, manifest: got.manifest }, ...below];
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return [{ status: "unavailable", dependency, message }];
        }
      }),
    );
    return lists.flat();
  }
}

/** 依存が輪になっているときの理由（リリースで拒むときにも使う） */
const CYCLE = "依存が輪になっています";
/** 依存の依存をたどる深さの上限 */
const MAX_DEPTH = 16;

/** lock ごとに一つにする（使えるものを優先） */
function dedupe(list: PackageResolution[]): PackageResolution[] {
  const out = new Map<string, PackageResolution>();
  for (const r of list) {
    const key = lockKey(r.dependency);
    const prev = out.get(key);
    if (!prev || (prev.status !== "ready" && r.status === "ready")) out.set(key, r);
  }
  return [...out.values()];
}
