import {
  diffFiles,
  emptyProject,
  forestSample,
  gunAndTargetSample,
  gunSample,
  isOfficial,
  marubatsuSample,
  targetRangeSample,
} from "@tukurium/repo-model";
import { workTagsSchema } from "@tukurium/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Store, User } from "../store/store";
import { ItemCatalog } from "./catalog";
import { HttpError, type RepoService } from "./service";

const TEMPLATES = {
  empty: (name: string) => emptyProject(name),
  sample: () => gunAndTargetSample(),
  gun: () => gunSample(),
  range: () => targetRangeSample(),
  forest: () => forestSample(),
  marubatsu: () => marubatsuSample(),
} as const;

const Selection = z.object({
  outputs: z.array(z.string()).default([]),
  kokostates: z.array(z.string()).default([]),
  systems: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  assets: z.array(z.string()).default([]),
});

/** リポジトリ・作品・プロフィールの API（ADR 0007） */
export interface RepoRouteHooks {
  /** プロジェクト名が変わった（開いているワークスペースへ反映する） */
  onRenamed?: (repoId: string, name: string) => Promise<void>;
}

export function registerRepoRoutes(
  app: FastifyInstance,
  store: Store,
  repos: RepoService,
  hooks: RepoRouteHooks = {},
) {
  const userOf = async (req: FastifyRequest): Promise<User | null> => {
    const token = req.headers["x-tukurium-token"];
    return typeof token === "string" ? store.userByToken(token) : null;
  };
  const needUser = async (req: FastifyRequest) => {
    const u = await userOf(req);
    if (!u) throw new HttpError(401, "本人確認ができません（接続し直してください）");
    return u;
  };
  const handle =
    <P>(fn: (req: FastifyRequest<{ Params: P }>, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest<{ Params: P }>, reply: FastifyReply) => {
      try {
        return await fn(req, reply);
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
        if (e instanceof z.ZodError)
          return reply.code(400).send({ error: "入力が正しくありません" });
        throw e;
      }
    };
  const ownerName = async (id: string) => (await store.user(id))?.name ?? "?";
  const withOwner = async <T extends { owner: string }>(x: T) => ({
    ...x,
    ownerName: await ownerName(x.owner),
  });
  const catalog = new ItemCatalog(store, repos);

  app.get(
    "/api/market",
    handle(async (req) => {
      const q = z
        .object({
          q: z.string().max(100).default(""),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
          limit: z.coerce.number().int().min(1).max(48).default(24),
          tag: z
            .union([
              z
                .string()
                .transform((tag) => [tag])
                .pipe(workTagsSchema),
              workTagsSchema,
            ])
            .default([]),
        })
        .parse(req.query);
      return catalog.search(await userOf(req), q.q, q.offset, q.limit, q.tag);
    }),
  );
  app.get(
    "/api/me/items",
    handle(async (req) => catalog.owned(await needUser(req))),
  );
  app.post(
    "/api/me/items/:workId",
    handle<{ workId: string }>(async (req) => {
      const user = await needUser(req);
      const { releaseId } = z.object({ releaseId: z.string().min(1).max(64) }).parse(req.body);
      return catalog.acquire(user, req.params.workId, releaseId);
    }),
  );
  app.put(
    "/api/me/items/:workId",
    handle<{ workId: string }>(async (req) => {
      const user = await needUser(req);
      const { releaseId } = z.object({ releaseId: z.string().min(1).max(64) }).parse(req.body);
      return catalog.update(user, req.params.workId, releaseId);
    }),
  );
  app.delete(
    "/api/me/items/:workId",
    handle<{ workId: string }>(async (req) =>
      catalog.remove(await needUser(req), req.params.workId),
    ),
  );

  app.post(
    "/api/repos",
    handle(async (req) => {
      const user = await needUser(req);
      const body = z
        .object({
          name: z.string().min(1).max(64),
          description: z.string().max(300).optional(),
          kind: z.enum(["item", "world"]).default("item"),
          visibility: z.enum(["public", "private"]).default("public"),
          template: z
            .enum(["empty", "sample", "gun", "range", "forest", "marubatsu"])
            .default("empty"),
        })
        .parse(req.body);
      const snapshot = TEMPLATES[body.template](body.name);
      if (body.template === "empty") for (const o of snapshot.outputs) o.kind = body.kind;
      // 森はワールド、マルバツはアイテム。ほかのひな形は選んだ種類のまま
      const kind =
        body.template === "forest" ? "world" : body.template === "marubatsu" ? "item" : body.kind;
      return withOwner(await repos.create(user, { ...body, kind, snapshot }));
    }),
  );

  app.get(
    "/api/repos",
    handle(async (req) => {
      const user = await userOf(req);
      const q = z.object({ owner: z.string().optional() }).parse(req.query);
      const list = await store.repos(q);
      const visible = [];
      for (const r of list) {
        if (!(await repos.canRead(user, r))) continue;
        // 一覧に出すサムネイルは、いまの版の最初のアウトプットのもの（ADR 0046）
        const snap = await repos.snapshot(r.id).catch(() => null);
        const thumbnail = snap?.outputs.find((o) => o.thumbnail)?.thumbnail ?? null;
        visible.push({ ...(await withOwner(r)), thumbnail });
      }
      return visible;
    }),
  );

  app.get(
    "/api/repos/:id",
    handle<{ id: string }>(async (req) => {
      const user = await userOf(req);
      const repo = await repos.readable(user, req.params.id);
      const head = await repos.git.head(repo.id);
      const snap = await repos.snapshot(repo.id);
      const works = await store.works({ repoId: repo.id });
      return {
        ...(await withOwner(repo)),
        head,
        outputs: snap.outputs.map((o) => ({ id: o.id, name: o.name, kind: o.kind })),
        provenance: snap.provenance ?? [],
        works: await Promise.all(
          works.map(async (w) => ({ ...w, releases: await store.releases(w.id) })),
        ),
        canFork: await repos.canFork(user, repo),
        isOwner: user?.id === repo.owner,
      };
    }),
  );

  app.patch(
    "/api/repos/:id",
    handle<{ id: string }>(async (req) => {
      const user = await needUser(req);
      const repo = await repos.require(req.params.id);
      if (repo.owner !== user.id) throw new HttpError(403, "設定を変えられるのは持ち主です");
      const body = z
        .object({
          name: z.string().trim().min(1, "名前を入れてください").max(64).optional(),
          description: z.string().max(300).optional(),
          visibility: z.enum(["public", "private"]).optional(),
        })
        .parse(req.body);
      const next = { ...repo, ...body };
      await store.saveRepo(next);
      if (body.name !== undefined && body.name !== repo.name)
        await hooks.onRenamed?.(repo.id, body.name);
      return next;
    }),
  );

  app.get(
    "/api/repos/:id/commits",
    handle<{ id: string }>(async (req) => {
      const repo = await repos.readable(await userOf(req), req.params.id);
      return repos.git.log(repo.id);
    }),
  );

  app.get(
    "/api/repos/:id/files",
    handle<{ id: string }>(async (req) => {
      const repo = await repos.readable(await userOf(req), req.params.id);
      const { commit } = z.object({ commit: z.string().optional() }).parse(req.query);
      return repos.git.files(repo.id, commit);
    }),
  );

  app.get(
    "/api/repos/:id/snapshot",
    handle<{ id: string }>(async (req) => {
      const repo = await repos.readable(await userOf(req), req.params.id);
      const { commit } = z.object({ commit: z.string().optional() }).parse(req.query);
      return repos.snapshot(repo.id, commit);
    }),
  );

  /** コミットの差分（ひとつ前のコミットとの） */
  app.get(
    "/api/repos/:id/commits/:oid/diff",
    handle<{ id: string; oid: string }>(async (req) => {
      const repo = await repos.readable(await userOf(req), req.params.id);
      const log = await repos.git.log(repo.id);
      const c = log.find((x) => x.oid === req.params.oid);
      if (!c) throw new HttpError(404, "コミットが見つかりません");
      const before = c.parents[0] ? await repos.git.files(repo.id, c.parents[0]) : {};
      return diffFiles(before, await repos.git.files(repo.id, c.oid));
    }),
  );

  app.post(
    "/api/repos/:id/fork",
    handle<{ id: string }>(async (req) => {
      const user = await needUser(req);
      const { name } = z
        .object({ name: z.string().min(1).max(64).optional() })
        .parse(req.body ?? {});
      return withOwner(await repos.fork(user, req.params.id, name));
    }),
  );

  /** 開いているワークスペースへ取り込むための、取り出し元の中身（フォークできる人だけ） */
  app.get(
    "/api/repos/:id/import-source",
    handle<{ id: string }>(async (req) => repos.importSource(await needUser(req), req.params.id)),
  );

  app.post(
    "/api/repos/:id/extract",
    handle<{ id: string }>(async (req) => {
      const user = await needUser(req);
      const body = z
        .object({
          selection: Selection,
          target: z.union([
            z.object({ name: z.string().min(1).max(64) }),
            z.object({ repoId: z.string() }),
          ]),
          commit: z.string().optional(),
        })
        .parse(req.body);
      const out = await repos.extract(
        user,
        req.params.id,
        body.selection,
        body.target,
        body.commit,
      );
      return { repo: await withOwner(out.repo), commit: out.commit };
    }),
  );

  app.post(
    "/api/works",
    handle(async (req) => {
      const user = await needUser(req);
      const body = z
        .object({
          repoId: z.string(),
          outputId: z.string(),
          name: z.string().min(1).max(64).optional(),
          tags: workTagsSchema.optional(),
        })
        .parse(req.body);
      return repos.publish(user, body.repoId, body.outputId, body.name, body.tags);
    }),
  );

  app.get(
    "/api/works/:id",
    handle<{ id: string }>(async (req) => catalog.detail(await userOf(req), req.params.id)),
  );

  app.get(
    "/api/works",
    handle(async (req) => {
      const q = z.object({ owner: z.string().optional() }).parse(req.query);
      const works = await store.works(q);
      return Promise.all(
        works.map(async (w) => {
          const latest = (await store.releases(w.id))[0] ?? null;
          // 置いたときの種類（ワールドは原点、アイテムは視線の先）は、リリースしたコミットのものを使う
          const snap = latest
            ? await repos.snapshot(w.repoId, latest.commit).catch(() => null)
            : null;
          const output = snap?.outputs.find((o) => o.id === w.outputId);
          const outputKind = output?.kind ?? null;
          return {
            ...(await withOwner(w)),
            repoName: (await store.repo(w.repoId))?.name ?? "?",
            latest,
            outputKind,
            // リリースした版のサムネイル（ADR 0046）
            thumbnail: output?.thumbnail ?? null,
            // 公式かどうかは発行者で決める（名前は見ない。ADR 0013 §1）
            official: isOfficial(w.owner),
          };
        }),
      );
    }),
  );

  app.patch(
    "/api/works/:id",
    handle<{ id: string }>(async (req) => {
      const user = await needUser(req);
      const work = await store.work(req.params.id);
      if (!work) throw new HttpError(404, "リリースが見つかりません");
      if (work.owner !== user.id)
        throw new HttpError(403, "リリースの情報を変更できるのは作者です");
      const body = z
        .object({
          name: z.string().min(1).max(64).optional(),
          tags: workTagsSchema.optional(),
          perms: z
            .object({ use: z.boolean(), view: z.boolean(), fork: z.boolean() })
            .partial()
            .optional(),
        })
        .parse(req.body);
      const next = {
        ...work,
        name: body.name ?? work.name,
        tags: body.tags ?? work.tags ?? [],
        perms: { ...work.perms, ...body.perms },
      };
      await store.saveWork(next);
      return next;
    }),
  );

  app.post(
    "/api/works/:id/releases",
    handle<{ id: string }>(async (req) => {
      const user = await needUser(req);
      const { commit } = z.object({ commit: z.string().optional() }).parse(req.body ?? {});
      return repos.release(user, req.params.id, commit);
    }),
  );

  app.get(
    "/api/works/:id/releases/:version/package",
    handle<{ id: string; version: string }>(async (req) => {
      const version = z.coerce.number().int().positive().parse(req.params.version);
      return repos.packageVersion(await userOf(req), req.params.id, version);
    }),
  );

  app.get(
    "/api/users/:id",
    handle<{ id: string }>(async (req) => {
      const viewer = await userOf(req);
      const u = await store.user(req.params.id);
      if (!u) throw new HttpError(404, "ユーザーが見つかりません");
      const list = [];
      for (const r of await store.repos({ owner: u.id }))
        if (await repos.canRead(viewer, r)) list.push(r);
      return { ...u, repos: list, works: await store.works({ owner: u.id }) };
    }),
  );
}
