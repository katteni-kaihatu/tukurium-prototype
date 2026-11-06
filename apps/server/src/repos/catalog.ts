import { tagKey } from "@tukurium/shared";
import type { OwnedItem, Store, User, Work } from "../store/store";
import { HttpError, type RepoService } from "./service";

/** 作品を正本として、マーケットと所持一覧で同じ情報を使う。 */
export class ItemCatalog {
  constructor(
    private readonly store: Store,
    private readonly repos: RepoService,
  ) {}

  async describe(work: Work) {
    const latest = (await this.store.releases(work.id))[0] ?? null;
    const repo = await this.store.repo(work.repoId);
    const snapshot = latest
      ? await this.repos.snapshot(work.repoId, latest.commit).catch(() => null)
      : null;
    const output = snapshot?.outputs.find((o) => o.id === work.outputId);
    return {
      ...work,
      // リリースした版のサムネイル（Resources の画像の素材 ID。ADR 0046）
      thumbnail: output?.thumbnail ?? null,
      tags: work.tags ?? [],
      ownerName: (await this.store.user(work.owner))?.name ?? "?",
      repoName: repo?.name ?? "?",
      latest,
      outputKind: output?.kind ?? (latest ? null : (repo?.kind ?? null)),
    };
  }

  async search(
    user: User | null,
    query: string,
    offset: number,
    limit: number,
    tags: string[] = [],
  ) {
    const words = tagKey(query).split(/\s+/).filter(Boolean);
    const entries = await Promise.all(
      (await this.store.works())
        .filter((w) => w.owner === user?.id || w.perms.use || w.perms.view || w.perms.fork)
        .map((w) => this.describe(w)),
    );
    const filtered = entries
      .filter(
        (w) =>
          w.outputKind === "item" &&
          words.every((word) =>
            tagKey(`${w.name} ${w.ownerName} ${w.tags.join(" ")}`).includes(word),
          ) &&
          tags.every((tag) => w.tags.some((value) => tagKey(value) === tagKey(tag))),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const items = filtered.slice(offset, offset + limit);
    return {
      items,
      total: filtered.length,
      offset,
      limit,
      nextOffset: offset + items.length < filtered.length ? offset + items.length : null,
    };
  }

  async acquire(user: User, workId: string, releaseId: string) {
    const work = await this.store.work(workId);
    const release = await this.store.release(releaseId);
    if (!work || !release || release.workId !== work.id)
      throw new HttpError(404, "作品のリリースが見つかりません");
    if (!work.perms.use && work.owner !== user.id)
      throw new HttpError(403, "この作品を利用する権限がありません");
    const snapshot = await this.repos.snapshot(work.repoId, release.commit);
    if (snapshot.outputs.find((o) => o.id === work.outputId)?.kind !== "item")
      throw new HttpError(400, "所持できるのはアイテムです");
    const item = await this.store.acquireItem({
      userId: user.id,
      workId,
      releaseId,
      acquiredAt: new Date().toISOString(),
    });
    return this.ownedEntry(user, item);
  }

  async owned(user: User) {
    return Promise.all(
      (await this.store.ownedItems(user.id)).map((item) => this.ownedEntry(user, item)),
    );
  }

  private async ownedEntry(user: User, item: OwnedItem) {
    const work = await this.store.work(item.workId);
    const release = await this.store.release(item.releaseId);
    const info = work ? await this.describe(work) : null;
    const available = !!work && !!release && (work.perms.use || work.owner === user.id);
    return {
      ...item,
      work: info,
      release,
      available,
      reason: available
        ? null
        : !work || !release
          ? "作品のリリースが見つかりません"
          : "この作品を利用する権限がありません",
    };
  }
}
