import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../app/store";
import { Thumbnail } from "../app/Thumbnail";
import { api, type OwnedItem, type Work } from "../net/api";
import { CatalogNotice, ItemAction, ItemDetailsPlaceholder, priceLabel } from "./CatalogPage";
import { refreshOwned, removeOwned, updateOwned, useCatalog } from "./catalogStore";
import { newerRelease, shelfItems, useItemShelf } from "./itemShelf";
import common from "./MainMenu.module.css";
import styles from "./OwnedItemsPage.module.css";
import { useMainMenu } from "./store";
import { WorkTagsEditor } from "./WorkTags";

export function OwnedItemsPage() {
  /** 所持アイテムの一覧か、自分がリリースしたアイテム（非公開も含む）の一覧か */
  const [view, setView] = useState<"owned" | "mine">("owned");
  if (view === "mine") return <MyItems onBack={() => setView("owned")} />;
  return <OwnedItems onMine={() => setView("mine")} />;
}

function OwnedItems({ onMine }: { onMine(): void }) {
  const catalog = useCatalog();
  const shelf = useItemShelf();
  const menu = useMainMenu();
  const status = useApp((s) => s.status);
  const session = useApp((s) => s.session);
  useEffect(() => shelf.load(catalog.owner), [catalog.owner, shelf.load]);
  const labels = useMemo(
    () => (shelf.owner === catalog.owner ? shelf.labels : {}),
    [shelf.owner, catalog.owner, shelf.labels],
  );
  // 自分がリリースしたアイテムは、入手していなくても並べる（入手していれば、所持している版を出す）
  const mine = useMyItems();
  const ownedIds = new Set(catalog.owned.map((item) => item.workId));
  const all = [
    ...catalog.owned,
    ...mine.works.filter((work) => !ownedIds.has(work.id)).map(ownCopy),
  ];
  const tags = [...new Set([...shelf.tags, ...all.flatMap((item) => item.work?.tags ?? [])])].sort(
    (a, b) => a.localeCompare(b, "ja"),
  );
  const entries = shelfItems(all, labels, { ...shelf, query: menu.queries.items });
  // 絞り込み後も、確認中のアイテムは詳細に残す。
  const selected = all.find((item) => item.workId === menu.selected.items);
  const filtering =
    !!menu.queries.items.trim() ||
    shelf.filter !== "all" ||
    shelf.tags.length > 0 ||
    shelf.availableOnly;
  const favorites = all.filter((item) => labels[item.workId]?.favorite).length;
  const ready = !!catalog.owner && shelf.owner === catalog.owner;
  const clearFilters = () => {
    shelf.clearFilters();
    menu.setQuery("items", "");
  };
  return (
    <div className={styles.shelf}>
      <div className={common.pageHeader}>
        <h1>
          アイテム <span className={styles.total}>{all.length}</span>
        </h1>
        <div className={common.headerActions}>
          <button type="button" className={common.button} onClick={onMine}>
            自分のアイテム
          </button>
          <button type="button" className={common.button} onClick={() => menu.selectPage("market")}>
            マーケットを見る <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>

      <div className={styles.body} data-detail="true">
        <div className={styles.results}>
          <div className={styles.tools}>
            <label className={styles.search}>
              <Glyph kind="search" />
              <input
                aria-label="所持アイテムを検索"
                placeholder="名前・作者・タグで検索"
                maxLength={100}
                value={menu.queries.items}
                onChange={(e) => menu.setQuery("items", e.target.value)}
              />
              {menu.queries.items && (
                <button
                  type="button"
                  aria-label="検索をクリア"
                  onClick={() => menu.setQuery("items", "")}
                >
                  <Glyph kind="close" />
                </button>
              )}
            </label>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="所持アイテムを更新"
              title="所持アイテムを更新"
              disabled={status !== "online" || catalog.ownedLoading}
              onClick={() => {
                void refreshOwned();
                mine.reload();
              }}
            >
              <Glyph kind="refresh" />
            </button>
          </div>

          <section className={styles.filters} aria-label="所持アイテムの絞り込み">
            <div className={styles.tabs}>
              <button
                type="button"
                aria-pressed={shelf.filter === "all"}
                onClick={() => useItemShelf.setState({ filter: "all" })}
              >
                すべて <span>{all.length}</span>
              </button>
              <button
                type="button"
                aria-pressed={shelf.filter === "favorites"}
                onClick={() => useItemShelf.setState({ filter: "favorites" })}
              >
                <Glyph kind="star" />
                お気に入り <span>{favorites}</span>
              </button>
            </div>
            <fieldset className={styles.tagFilters}>
              <legend className={styles.srOnly}>タグで絞り込む</legend>
              <Glyph kind="tag" />
              {tags.length ? (
                tags.map((tag) => (
                  <button
                    type="button"
                    key={tag}
                    className={styles.tag}
                    aria-pressed={shelf.tags.includes(tag)}
                    onClick={() => shelf.toggleTag(tag)}
                  >
                    {tag}
                  </button>
                ))
              ) : (
                <span className={common.caption}>作者が付けたタグで絞り込めます</span>
              )}
              {shelf.tags.length > 0 && (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => useItemShelf.setState({ tags: [] })}
                >
                  タグを解除
                </button>
              )}
            </fieldset>
          </section>

          <div className={styles.resultBar}>
            <span aria-live="polite">
              {entries.length}件{filtering && ` / ${all.length}件`}
            </span>
            <label className={styles.available}>
              <input
                type="checkbox"
                checked={shelf.availableOnly}
                onChange={(e) => useItemShelf.setState({ availableOnly: e.target.checked })}
              />
              利用できるもの
            </label>
            <label className={styles.sort}>
              <span className={styles.srOnly}>並べ替え</span>
              <select
                aria-label="アイテムを並べ替え"
                value={shelf.sort}
                disabled={!ready}
                onChange={(e) => shelf.setSort(e.target.value as typeof shelf.sort)}
              >
                <option value="newest">入手した順</option>
                <option value="name">名前順</option>
                <option value="author">作者順</option>
              </select>
            </label>
            <fieldset className={styles.viewSwitch}>
              <legend className={styles.srOnly}>一覧の表示方法</legend>
              <button
                type="button"
                aria-label="カード表示"
                aria-pressed={shelf.layout === "grid"}
                disabled={!ready}
                onClick={() => shelf.setLayout("grid")}
              >
                <Glyph kind="grid" />
              </button>
              <button
                type="button"
                aria-label="リスト表示"
                aria-pressed={shelf.layout === "list"}
                disabled={!ready}
                onClick={() => shelf.setLayout("list")}
              >
                <Glyph kind="list" />
              </button>
            </fieldset>
          </div>

          {status !== "online" && (
            <p className={common.notice} role="status">
              接続を確認しています。取り出しは接続後に使えます。
            </p>
          )}
          <CatalogNotice />
          {shelf.storageError && (
            <p className={common.error} role="alert">
              整理情報をブラウザに保存できません。再読み込みすると変更が失われる場合があります。
            </p>
          )}
          {catalog.ownedLoading && (
            <p className={common.muted} role="status">
              所持アイテムを確認しています…
            </p>
          )}

          {!catalog.ownedLoading &&
            !catalog.ownedError &&
            catalog.ownedLoaded &&
            entries.length === 0 && (
              <div className={styles.empty}>
                <Glyph kind={filtering ? "search" : "box"} />
                <h2>
                  {filtering ? "一致するアイテムがありません" : "まだアイテムを持っていません"}
                </h2>
                <p>
                  {filtering
                    ? "検索やタグを変えて探してみてください。"
                    : "マーケットで入手したアイテムが、ここに並びます。"}
                </p>
                <button
                  type="button"
                  className={common.button}
                  onClick={filtering ? clearFilters : () => menu.selectPage("market")}
                >
                  {filtering ? "絞り込みを解除" : "マーケットを見る"}
                </button>
              </div>
            )}
          <div className={styles.items} data-layout={shelf.layout}>
            {entries.map((item) => (
              <article
                key={item.workId}
                className={styles.card}
                data-selected={selected?.workId === item.workId}
              >
                <button
                  type="button"
                  className={styles.cardOpen}
                  aria-label={`${item.work?.name ?? "利用できないアイテム"} の詳細`}
                  aria-pressed={selected?.workId === item.workId}
                  onClick={() => menu.select("items", item.workId)}
                >
                  <ItemThumbnail work={item.work} />
                  <span className={styles.cardInfo}>
                    <strong>{item.work?.name ?? "利用できないアイテム"}</strong>
                    <span className={common.caption}>{item.work?.ownerName ?? "作者不明"}</span>
                    <span className={styles.version}>
                      v{item.release?.version ?? "?"}
                      {isPrivate(item) && <span className={styles.privateBadge}>非公開</span>}
                      {!item.available && <span className={styles.unavailable}>利用不可</span>}
                      {newerRelease(item) && (
                        <span className={styles.updateBadge}>
                          v{newerRelease(item)?.version} あり
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.favorite}
                  disabled={!ready}
                  aria-label={`${item.work?.name ?? "アイテム"}をお気に入り${labels[item.workId]?.favorite ? "から外す" : "に追加"}`}
                  aria-pressed={!!labels[item.workId]?.favorite}
                  onClick={() => shelf.toggleFavorite(item.workId)}
                >
                  <Glyph kind="star" />
                </button>
                {!!item.work?.tags?.length && (
                  <div className={styles.cardTags}>
                    {item.work?.tags?.map((tag) => (
                      <button
                        type="button"
                        className={styles.tag}
                        key={tag}
                        aria-pressed={shelf.tags.includes(tag)}
                        onClick={() => shelf.toggleTag(tag)}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
                <div className={styles.cardAction}>
                  <ItemAction work={item.work} item={item} />
                </div>
              </article>
            ))}
          </div>
        </div>
        {selected ? (
          <ItemDetails
            key={selected.workId}
            item={selected}
            held={ownedIds.has(selected.workId)}
            onClose={() => menu.select("items", undefined)}
          />
        ) : (
          <ItemDetailsPlaceholder className={styles.detail} />
        )}
      </div>

      <p className={styles.storageNote}>
        <Glyph kind="tag" />
        公開タグは作者が設定します。お気に入り・表示方法はこのブラウザに保存されます。
      </p>
      {session && (
        <p className={styles.destination}>
          <span className={styles.onlineDot} />
          取り出し先: <strong>{session.name}</strong>
        </p>
      )}
    </div>
  );
}

/** 自分がリリースしたアイテム（マーケットに出していない非公開のものも含む）を読む */
function useMyItems() {
  const owner = useCatalog((s) => s.owner);
  const [works, setWorks] = useState<Work[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const current = ++seq.current;
    setError(null);
    api.myMarket().then(
      (mine) => {
        if (current !== seq.current) return;
        setWorks(
          [...mine.listed, ...mine.unlisted].filter((w) => w.outputKind === "item" && w.latest),
        );
        setLoaded(true);
      },
      (e: Error) => {
        if (current !== seq.current) return;
        setError(e.message);
        setLoaded(true);
      },
    );
  }, []);
  // 本人が変わったら、前の人の一覧を残さない
  useEffect(() => {
    seq.current++;
    setWorks([]);
    setLoaded(false);
    if (owner) reload();
  }, [owner, reload]);
  return { works, loaded, error, reload };
}

/** マーケットに出していない、自分の作品か */
function isPrivate(item: OwnedItem) {
  return !!item.work && item.work.owner === item.userId && !item.work.market;
}

/**
 * 自分がリリースしたアイテム。マーケットに出していない非公開のものも含む。
 * 作者は入手しなくても使えるので、所持アイテムには加えずに、最新の版をそのまま取り出す。
 */
function MyItems({ onBack }: { onBack(): void }) {
  const status = useApp((s) => s.status);
  const session = useApp((s) => s.session);
  const { works, loaded, error, reload } = useMyItems();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const words = query.trim().toLocaleLowerCase();
  const entries = works.filter((w) =>
    `${w.name} ${w.repoName ?? ""} ${(w.tags ?? []).join(" ")}`.toLocaleLowerCase().includes(words),
  );
  const selected = works.find((w) => w.id === selectedId);
  return (
    <div className={styles.shelf}>
      <button type="button" className={common.backLink} onClick={onBack}>
        ← 所持アイテムへ戻る
      </button>
      <div className={common.pageHeader}>
        <div>
          <h1>
            自分のアイテム <span className={styles.total}>{works.length}</span>
          </h1>
          <p className={common.muted}>
            自分がリリースしたアイテムです。マーケットに出していない非公開のアイテムは、自分だけが取り出せます。
          </p>
        </div>
      </div>
      <div className={styles.body} data-detail="true">
        <div className={styles.results}>
          <div className={styles.tools}>
            <label className={styles.search}>
              <Glyph kind="search" />
              <input
                aria-label="自分のアイテムを検索"
                placeholder="名前・プロジェクト・タグで検索"
                maxLength={100}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="自分のアイテムを更新"
              title="自分のアイテムを更新"
              disabled={status !== "online"}
              onClick={reload}
            >
              <Glyph kind="refresh" />
            </button>
          </div>
          {status !== "online" && (
            <p className={common.notice} role="status">
              接続を確認しています。取り出しは接続後に使えます。
            </p>
          )}
          <CatalogNotice />
          {error && (
            <p className={common.error} role="alert">
              {error}
            </p>
          )}
          {!loaded && (
            <p className={common.muted} role="status">
              自分のアイテムを読み込んでいます…
            </p>
          )}
          {loaded && !error && entries.length === 0 && (
            <div className={styles.empty}>
              <Glyph kind={words ? "search" : "box"} />
              <h2>
                {words ? "一致するアイテムがありません" : "リリースしたアイテムはまだありません"}
              </h2>
              <p>
                {words
                  ? "検索の言葉を変えてみてください。"
                  : "プロジェクトでアイテムをリリースすると、ここに並びます。"}
              </p>
            </div>
          )}
          <div className={styles.items} data-layout="grid">
            {entries.map((work) => (
              <article
                key={work.id}
                className={styles.card}
                data-selected={selected?.id === work.id}
              >
                <button
                  type="button"
                  className={styles.cardOpen}
                  aria-label={`${work.name} の詳細`}
                  aria-pressed={selected?.id === work.id}
                  onClick={() => setSelectedId(work.id)}
                >
                  <ItemThumbnail work={work} />
                  <span className={styles.cardInfo}>
                    <strong>{work.name}</strong>
                    <span className={common.caption}>{marketLabel(work)}</span>
                    <span className={styles.version}>v{work.latest?.version ?? "?"}</span>
                  </span>
                </button>
                <div className={styles.cardAction}>
                  <ItemAction work={work} item={ownCopy(work)} />
                </div>
              </article>
            ))}
          </div>
        </div>
        {selected ? (
          <aside className={styles.detail} aria-label="アイテムの詳細">
            <div className={styles.detailHeading}>
              <span>アイテムの詳細</span>
              <button
                type="button"
                className={styles.iconButton}
                aria-label="アイテムの詳細を閉じる"
                onClick={() => setSelectedId(null)}
              >
                <Glyph kind="close" />
              </button>
            </div>
            <ItemThumbnail work={selected} />
            <div className={styles.detailCopy}>
              <span className={styles.typeBadge}>3Dアイテム</span>
              {!selected.market && (
                <span className={styles.privateBadge}>非公開（マーケットに出していません）</span>
              )}
              <h2>{selected.name}</h2>
              <p className={common.muted}>プロジェクト: {selected.repoName ?? "?"}</p>
              <dl className={styles.metadata}>
                <dt>取り出す版</dt>
                <dd>v{selected.latest?.version ?? "?"}（最新）</dd>
                <dt>マーケット</dt>
                <dd>
                  {selected.market
                    ? `${priceLabel(selected.market.price)}・v${selected.market.release?.version ?? "?"} を公開中`
                    : "出していません"}
                </dd>
              </dl>
              <div className={styles.detailAction}>
                <ItemAction work={selected} item={ownCopy(selected)} />
              </div>
            </div>
          </aside>
        ) : (
          <ItemDetailsPlaceholder className={styles.detail} />
        )}
      </div>
      {session && (
        <p className={styles.destination}>
          <span className={styles.onlineDot} />
          取り出し先: <strong>{session.name}</strong>
        </p>
      )}
    </div>
  );
}

/** カードに出す、マーケットでの状態 */
function marketLabel(work: Work) {
  return work.market ? `マーケット · ${priceLabel(work.market.price)}` : "非公開";
}

/** 自分の作品の最新の版を、所持アイテムと同じ形で扱う（所持一覧には加えない） */
function ownCopy(work: Work): OwnedItem {
  return {
    userId: work.owner,
    workId: work.id,
    releaseId: work.latest?.id ?? "",
    acquiredAt: work.createdAt,
    work,
    release: work.latest ?? null,
    available: !!work.latest,
    reason: work.latest ? null : "バージョンがありません",
  };
}

function ItemDetails({
  item,
  held,
  onClose,
}: {
  item: OwnedItem;
  /** 所持アイテムに入っているか（自分の作品は、入手していなくても並ぶ） */
  held: boolean;
  onClose(): void;
}) {
  const name = item.work?.name ?? "利用できないアイテム";
  const busy = useCatalog((s) => s.busy);
  const online = useApp((s) => s.status === "online");
  const newer = held ? newerRelease(item) : null;
  const remove = () => {
    if (
      window.confirm(
        `「${name}」を所持アイテムから消しますか？\nセッションに出しているものは残ります。マーケットからまた入手できます。`,
      )
    )
      void removeOwned(item);
  };
  return (
    <aside className={styles.detail} aria-label="アイテムの詳細">
      <div className={styles.detailHeading}>
        <span>アイテムの詳細</span>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="アイテムの詳細を閉じる"
          onClick={onClose}
        >
          <Glyph kind="close" />
        </button>
      </div>
      <ItemThumbnail work={item.work} />
      <div className={styles.detailCopy}>
        <span className={styles.typeBadge}>3Dアイテム</span>
        {isPrivate(item) && (
          <span className={styles.privateBadge}>非公開（マーケットに出していません）</span>
        )}
        <h2>{name}</h2>
        <p className={common.muted}>作者: {item.work?.ownerName ?? "不明"}</p>
        {held ? (
          <dl className={styles.metadata}>
            <dt>所持している版</dt>
            <dd>v{item.release?.version ?? "?"}</dd>
            <dt>最新の版</dt>
            <dd>{item.work?.latest ? `v${item.work.latest.version}` : "なし"}</dd>
            <dt>入手日</dt>
            <dd>{new Date(item.acquiredAt).toLocaleDateString("ja-JP")}</dd>
          </dl>
        ) : (
          <dl className={styles.metadata}>
            <dt>取り出す版</dt>
            <dd>v{item.release?.version ?? "?"}（最新）</dd>
            <dt>入手</dt>
            <dd>自分の作品なので不要</dd>
          </dl>
        )}
        {newer && (
          <div className={styles.update}>
            <p>新しい版 v{newer.version} が出ています。</p>
            <button
              type="button"
              className={common.button}
              disabled={!!busy || !online}
              onClick={() => void updateOwned(item, newer.id)}
            >
              v{newer.version} にアップデート
            </button>
          </div>
        )}
        <div className={styles.detailAction}>
          <ItemAction work={item.work} item={item} />
        </div>
        {item.work && <WorkTagsEditor work={item.work} />}
        {held && (
          <button
            type="button"
            className={styles.removeButton}
            disabled={!!busy || !online}
            onClick={remove}
          >
            所持アイテムから消す
          </button>
        )}
      </div>
    </aside>
  );
}

function ItemThumbnail({ work }: { work: Work | null }) {
  // サムネイルがあればそれを出す（ADR 0046）
  if (work?.thumbnail)
    return (
      <span className={`${styles.visual} ${styles.visualImage}`} aria-hidden="true">
        <Thumbnail id={work.thumbnail} name={work.name} />
      </span>
    );
  return (
    <span className={styles.visual} aria-hidden="true">
      <Glyph kind="box" />
      <span>
        {Array.from(work?.name ?? "?")
          .slice(0, 2)
          .join("")}
      </span>
    </span>
  );
}

function Glyph({
  kind,
}: {
  kind: "search" | "close" | "refresh" | "star" | "tag" | "grid" | "list" | "box";
}) {
  const paths = {
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7" />
      </>
    ),
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" />,
    tag: (
      <>
        <path d="M3 4h8l10 10-7 7L3 10z" />
        <circle cx="7" cy="8" r="1" />
      </>
    ),
    grid: <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />,
    list: <path d="M3 4h4v4H3zM11 6h10M3 10h4v4H3zM11 12h10M3 16h4v4H3zM11 18h10" />,
    box: <path d="m3 7 9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10" />,
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[kind]}
    </svg>
  );
}
