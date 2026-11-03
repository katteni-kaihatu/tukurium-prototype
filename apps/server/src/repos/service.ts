import { randomUUID } from "node:crypto";
import {
  type ExtractSelection,
  extractInto,
  fromFiles,
  type ProjectSnapshot,
  toFiles,
} from "@tukurium/repo-model";
import type { Release, RepoMeta, Store, User, Work, WorkPerms } from "../store/store";
import { type Author, GitStore } from "./gitStore";

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

  constructor(
    private readonly store: Store,
    gitRoot: string,
  ) {
    this.git = new GitStore(gitRoot);
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
    },
    forkedFrom: RepoMeta["forkedFrom"] = null,
  ): Promise<RepoMeta> {
    const meta: RepoMeta = {
      id: shortId("r"),
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
      const dst = await this.require(target.repoId);
      if (dst.owner !== user.id)
        throw new HttpError(403, "取り込み先は自分のリポジトリにしてください");
      const merged = extractInto(snap, selection, source, await this.snapshot(dst.id));
      const oid = await this.commit(dst.id, merged, `${src.name} から抽出して取り込み`, user, []);
      return { repo: dst, commit: oid };
    }
    const extracted = extractInto(snap, selection, source, null, target.name);
    const repo = await this.create(user, { name: target.name, snapshot: extracted });
    return { repo, commit: (await this.git.head(repo.id)) as string };
  }

  async publish(user: User, repoId: string, outputId: string, name?: string): Promise<Work> {
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
    const prev = await this.store.releases(workId);
    const r: Release = {
      id: shortId("rel"),
      workId,
      version: (prev[0]?.version ?? 0) + 1,
      commit: at,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveRelease(r);
    return r;
  }
}
