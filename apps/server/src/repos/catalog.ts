import { randomUUID } from "node:crypto";
import { tagKey, workTagsSchema } from "@tukurium/shared";
import {
  AUTHOR_SHARE,
  type Listing,
  type MarketEvent,
  type OwnedItem,
  type Release,
  type Store,
  type User,
  type Work,
} from "../store/store";
import { HttpError, type RepoService } from "./service";

const shortId = (p: string) => `${p}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;

/** マーケットで売れる種類（ライブラリは import で使うので出さない） */
const SELLABLE = new Set(["item", "world"]);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type MarketEventInput = DistributiveOmit<MarketEvent, "id" | "at">;

export type MarketSort = "new" | "popular" | "cheap";
export type MarketKind = "all" | "item" | "world";

export interface ListingInput {
  price: number;
  tags?: string[];
  autoPublish: boolean;
  /** 自動公開がオフのとき：公開する版 */
  releaseId?: string;
}

/** 作品を正本として、マーケットと所持一覧で同じ情報を使う。 */
export class ItemCatalog {
  constructor(
    private readonly store: Store,
    private readonly repos: RepoService,
  ) {}

  async describe(work: Work) {
    const releases = await this.store.releases(work.id);
    const latest = releases[0] ?? null;
    const repo = await this.store.repo(work.repoId);
    const snapshot = latest
      ? await this.repos.snapshot(work.repoId, latest.commit).catch(() => null)
      : null;
    const output = snapshot?.outputs.find((o) => o.id === work.outputId);
    const listing = await this.store.listing(work.id);
    const published = listing ? (releases.find((r) => r.id === listing.releaseId) ?? null) : null;
    return {
      ...work,
      // リリースした版のサムネイル（Resources の画像の素材 ID。ADR 0046）
      thumbnail: output?.thumbnail ?? null,
      tags: work.tags ?? [],
      ownerName: (await this.store.user(work.owner))?.name ?? "?",
      repoName: repo?.name ?? "?",
      latest,
      outputKind: output?.kind ?? (latest ? null : (repo?.kind ?? null)),
      market: listing
        ? {
            price: listing.price,
            autoPublish: listing.autoPublish,
            release: published,
            listedAt: listing.listedAt,
            acquisitions: (await this.store.sales({ workId: work.id })).length,
          }
        : null,
    };
  }

  /** 作品の詳細。バージョンと、その版を出した保存のメッセージ、マーケットの履歴を付ける。 */
  async detail(user: User | null, workId: string) {
    const work = await this.store.work(workId);
    const visible =
      !!work && (work.owner === user?.id || work.perms.use || work.perms.view || work.perms.fork);
    if (!work || !visible) throw new HttpError(404, "リリースが見つかりません");
    const info = await this.describe(work);
    const repo = await this.store.repo(work.repoId);
    const all = await this.store.releases(work.id);
    const releases = await Promise.all(
      all.map(async (release) => ({
        ...release,
        comment: await this.repos.git.message(work.repoId, release.commit),
      })),
    );
    return {
      ...info,
      releases,
      history: await this.store.marketEvents(work.id),
      // 非公開のプロジェクトは、作品を使えても参照を出さない
      project: repo?.visibility === "public" ? { id: repo.id, name: repo.name } : null,
    };
  }

  /** マーケットの一覧：登録された作品だけを出す */
  async search(
    user: User | null,
    query: string,
    offset: number,
    limit: number,
    tags: string[] = [],
    kind: MarketKind = "all",
    sort: MarketSort = "new",
  ) {
    const words = tagKey(query).split(/\s+/).filter(Boolean);
    const entries: Awaited<ReturnType<ItemCatalog["describe"]>>[] = [];
    for (const listing of await this.store.listings()) {
      const work = await this.store.work(listing.workId);
      if (
        !work ||
        !(work.owner === user?.id || work.perms.use || work.perms.view || work.perms.fork)
      )
        continue;
      entries.push(await this.describe(work));
    }
    const filtered = entries
      .filter(
        (w) =>
          !!w.market?.release &&
          SELLABLE.has(w.outputKind ?? "") &&
          (kind === "all" || w.outputKind === kind) &&
          words.every((word) =>
            tagKey(`${w.name} ${w.ownerName} ${w.tags.join(" ")}`).includes(word),
          ) &&
          tags.every((tag) => w.tags.some((value) => tagKey(value) === tagKey(tag))),
      )
      .sort((a, b) => {
        const byNew =
          (b.market?.listedAt ?? "").localeCompare(a.market?.listedAt ?? "") ||
          a.id.localeCompare(b.id);
        if (sort === "popular")
          return (b.market?.acquisitions ?? 0) - (a.market?.acquisitions ?? 0) || byNew;
        if (sort === "cheap") return (a.market?.price ?? 0) - (b.market?.price ?? 0) || byNew;
        return byNew;
      });
    const items = filtered.slice(offset, offset + limit);
    return {
      items,
      total: filtered.length,
      offset,
      limit,
      nextOffset: offset + items.length < filtered.length ? offset + items.length : null,
    };
  }

  /**
   * 入手する。作者は自分の作品をいつでも無料で（最新の版を）持てる。
   * ほかの人は、マーケットに登録された作品だけを、公開中の版で買う。
   */
  async acquire(user: User, workId: string) {
    const work = await this.store.work(workId);
    if (!work) throw new HttpError(404, "リリースが見つかりません");
    if (!work.perms.use && work.owner !== user.id)
      throw new HttpError(403, "このリリースを利用する権限がありません");
    const listing = await this.store.listing(workId);
    const own = work.owner === user.id;
    if (!own && !listing) throw new HttpError(404, "マーケットに登録されていません");
    const releaseId = own
      ? (await this.store.releases(workId))[0]?.id
      : (listing as Listing).releaseId;
    if (!releaseId) throw new HttpError(404, "リリースのバージョンが見つかりません");
    await this.usableRelease(user, workId, releaseId);
    const at = new Date().toISOString();
    if (own) {
      // 自分の作品は記録を残さない（入手の数にも入れない）
      const item = await this.store.acquireItem({
        userId: user.id,
        workId,
        releaseId,
        acquiredAt: at,
      });
      return { ...(await this.ownedEntry(user, item)), balance: await this.store.balance(user.id) };
    }
    const price = (listing as Listing).price;
    const result = await this.store.purchase(
      { userId: user.id, workId, releaseId, acquiredAt: at },
      {
        id: shortId("sale"),
        workId,
        sellerId: work.owner,
        buyerId: user.id,
        releaseId,
        price,
        earned: Math.floor(price * AUTHOR_SHARE),
        at,
      },
    );
    if (!result.ok)
      throw new HttpError(
        402,
        `ポイントが足りません（${price} P 必要・持っているのは ${result.balance} P）`,
      );
    return { ...(await this.ownedEntry(user, result.item)), balance: result.balance };
  }

  /**
   * 所持している版を、同じ作品の別の版（ふつうは公開中の版）に替える。入手日は保つ。無料。
   * マーケットに登録されているときは、公開中の版より新しい版には替えられない。
   */
  async update(user: User, workId: string, releaseId: string) {
    await this.usableRelease(user, workId, releaseId);
    const work = await this.store.work(workId);
    const listing = await this.store.listing(workId);
    if (listing && work?.owner !== user.id) {
      const target = await this.store.release(releaseId);
      const published = await this.store.release(listing.releaseId);
      if (target && published && target.version > published.version)
        throw new HttpError(403, "まだマーケットで公開されていない版です");
    }
    const item = await this.store.updateOwnedItem(user.id, workId, releaseId);
    if (!item) throw new HttpError(404, "このアイテムを持っていません");
    return this.ownedEntry(user, item);
  }

  /** 所持一覧から消す。セッションに出ている配置はそのまま残る。 */
  async remove(user: User, workId: string) {
    await this.store.removeOwnedItem(user.id, workId);
    return { ok: true };
  }

  /**
   * 使えるか：利用の権限があり、マーケットで有料なら、作者か入手した人だけ。
   * 登録していない作品は、これまでどおり利用の権限だけで決まる。
   */
  async canUse(userId: string, work: { id: string; owner: string; perms: { use: boolean } }) {
    if (work.owner === userId) return true;
    if (!work.perms.use) return false;
    const listing = await this.store.listing(work.id);
    if (!listing || listing.price === 0) return true;
    return (await this.store.ownedItems(userId)).some((item) => item.workId === work.id);
  }

  private async usableRelease(user: User, workId: string, releaseId: string) {
    const work = await this.store.work(workId);
    const release = await this.store.release(releaseId);
    if (!work || !release || release.workId !== work.id)
      throw new HttpError(404, "リリースのバージョンが見つかりません");
    if (!work.perms.use && work.owner !== user.id)
      throw new HttpError(403, "このリリースを利用する権限がありません");
    const snapshot = await this.repos.snapshot(work.repoId, release.commit);
    if (!SELLABLE.has(snapshot.outputs.find((o) => o.id === work.outputId)?.kind ?? ""))
      throw new HttpError(400, "所持できるのはアイテムとワールドです");
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
          ? "リリースのバージョンが見つかりません"
          : "このリリースを利用する権限がありません",
    };
  }

  // ---- マイページ・登録 ----

  async wallet(user: User) {
    return { balance: await this.store.balance(user.id) };
  }

  /** マイページ：自分の作品（登録済み）、登録できる作品、入手の記録（誰が買ったかは出さない） */
  async mine(user: User) {
    const works = await Promise.all(
      (await this.store.works({ owner: user.id })).map((w) => this.describe(w)),
    );
    const sellable = works.filter((w) => SELLABLE.has(w.outputKind ?? ""));
    const names = new Map(works.map((w) => [w.id, w.name]));
    const sales = await this.store.sales({ sellerId: user.id });
    const versions = new Map<string, number>();
    for (const sale of sales) {
      if (!versions.has(sale.releaseId))
        versions.set(sale.releaseId, (await this.store.release(sale.releaseId))?.version ?? 0);
    }
    return {
      balance: await this.store.balance(user.id),
      listed: sellable
        .filter((w) => w.market)
        .sort((a, b) => (b.market?.listedAt ?? "").localeCompare(a.market?.listedAt ?? "")),
      // 登録していない作品（リリースのないものも、理由を出すために含める）
      unlisted: sellable.filter((w) => !w.market),
      sales: sales.map((sale) => ({
        id: sale.id,
        workId: sale.workId,
        workName: names.get(sale.workId) ?? "?",
        version: versions.get(sale.releaseId) ?? null,
        price: sale.price,
        earned: sale.earned,
        at: sale.at,
      })),
    };
  }

  private async ownWork(user: User, workId: string) {
    const work = await this.store.work(workId);
    if (!work) throw new HttpError(404, "リリースが見つかりません");
    if (work.owner !== user.id) throw new HttpError(403, "登録できるのは作者です");
    return work;
  }

  /** 公開する版を決める：自動公開なら最新、そうでなければ選んだ版 */
  private async chooseRelease(work: Work, autoPublish: boolean, releaseId?: string) {
    const releases = await this.store.releases(work.id);
    const chosen: Release | undefined = autoPublish
      ? releases[0]
      : releases.find((r) => r.id === releaseId);
    if (!releases.length) throw new HttpError(409, "まだリリースがありません");
    if (!chosen) throw new HttpError(400, "公開するバージョンを選んでください");
    return chosen;
  }

  private event(e: MarketEventInput) {
    return this.store.addMarketEvent({
      id: shortId("mev"),
      at: new Date().toISOString(),
      ...e,
    } as MarketEvent);
  }

  async register(user: User, workId: string, input: ListingInput) {
    const work = await this.ownWork(user, workId);
    if (await this.store.listing(workId))
      throw new HttpError(409, "この作品はもう登録されています");
    const info = await this.describe(work);
    if (!SELLABLE.has(info.outputKind ?? ""))
      throw new HttpError(400, "登録できるのはアイテムとワールドです");
    const release = await this.chooseRelease(work, input.autoPublish, input.releaseId);
    if (input.tags) await this.store.saveWork({ ...work, tags: workTagsSchema.parse(input.tags) });
    const now = new Date().toISOString();
    await this.store.saveListing({
      workId,
      owner: user.id,
      price: input.price,
      autoPublish: input.autoPublish,
      releaseId: release.id,
      listedAt: now,
      updatedAt: now,
    });
    await this.event({ workId, kind: "listed", version: release.version, price: input.price });
    return this.describe((await this.store.work(workId)) as Work);
  }

  async editListing(user: User, workId: string, input: Partial<ListingInput>) {
    const work = await this.ownWork(user, workId);
    const listing = await this.store.listing(workId);
    if (!listing) throw new HttpError(404, "マーケットに登録されていません");
    const autoPublish = input.autoPublish ?? listing.autoPublish;
    const release =
      input.autoPublish !== undefined || input.releaseId !== undefined
        ? await this.chooseRelease(work, autoPublish, input.releaseId ?? listing.releaseId)
        : null;
    const price = input.price ?? listing.price;
    if (input.tags) await this.store.saveWork({ ...work, tags: workTagsSchema.parse(input.tags) });
    await this.store.saveListing({
      ...listing,
      price,
      autoPublish,
      releaseId: release?.id ?? listing.releaseId,
      updatedAt: new Date().toISOString(),
    });
    if (price !== listing.price)
      await this.event({ workId, kind: "price", from: listing.price, to: price });
    if (release && release.id !== listing.releaseId)
      await this.event({ workId, kind: "published", version: release.version, auto: false });
    return this.describe((await this.store.work(workId)) as Work);
  }

  /** 登録を取り消す。入手した人はそのまま使える */
  async unlist(user: User, workId: string) {
    await this.ownWork(user, workId);
    if (!(await this.store.listing(workId))) return { ok: true };
    await this.store.removeListing(workId);
    await this.event({ workId, kind: "unlisted" });
    return { ok: true };
  }

  /** 新しい版を出したとき：自動公開なら、マーケットでもその版を公開する */
  async released(release: Release) {
    const listing = await this.store.listing(release.workId);
    if (!listing?.autoPublish || listing.releaseId === release.id) return;
    await this.store.saveListing({
      ...listing,
      releaseId: release.id,
      updatedAt: new Date().toISOString(),
    });
    await this.event({
      workId: release.workId,
      kind: "published",
      version: release.version,
      auto: true,
    });
  }
}
