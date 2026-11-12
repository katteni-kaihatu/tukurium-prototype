import type { PlacementInfo } from "@tukurium/shared";
import { useEffect, useMemo } from "react";
import { useApp } from "../app/store";
import { Thumbnail } from "../app/Thumbnail";
import type { OwnedItem, Work } from "../net/api";
import { CatalogNotice, ItemAction, ItemDetailsPlaceholder } from "./CatalogPage";
import { refreshOwned, useCatalog } from "./catalogStore";
import { shelfItems, useItemShelf } from "./itemShelf";
import common from "./MainMenu.module.css";
import styles from "./OwnedItemsPage.module.css";
import { sessionItemGroups } from "./sessionItems";
import { useMainMenu } from "./store";
import { WorkTagsEditor } from "./WorkTags";

export function OwnedItemsPage() {
  const catalog = useCatalog();
  const shelf = useItemShelf();
  const menu = useMainMenu();
  const status = useApp((s) => s.status);
  const session = useApp((s) => s.session);
  const me = useApp((s) => s.me);
  const client = useApp((s) => s.client);
  useEffect(() => shelf.load(catalog.owner), [catalog.owner, shelf.load]);
  const labels = useMemo(
    () => (shelf.owner === catalog.owner ? shelf.labels : {}),
    [shelf.owner, catalog.owner, shelf.labels],
  );
  const tags = [
    ...new Set([...shelf.tags, ...catalog.owned.flatMap((item) => item.work?.tags ?? [])]),
  ].sort((a, b) => a.localeCompare(b, "ja"));
  const entries = shelfItems(catalog.owned, labels, { ...shelf, query: menu.queries.items });
  const sessionItems = sessionItemGroups(
    catalog.owned,
    session?.placements ?? [],
    new Set(entries.map((item) => item.workId)),
  );
  const putAway = (placement: PlacementInfo) =>
    client.send({ t: "unplace", placementId: placement.id });
  // 絞り込み後も、確認中のアイテムは詳細に残す。
  const selected = catalog.owned.find((item) => item.workId === menu.selected.items);
  const filtering =
    !!menu.queries.items.trim() ||
    shelf.filter !== "all" ||
    shelf.tags.length > 0 ||
    shelf.availableOnly;
  const favorites = catalog.owned.filter((item) => labels[item.workId]?.favorite).length;
  const ready = !!catalog.owner && shelf.owner === catalog.owner;
  const clearFilters = () => {
    shelf.clearFilters();
    menu.setQuery("items", "");
  };
  return (
    <div className={styles.shelf}>
      <div className={common.pageHeader}>
        <h1>
          アイテム <span className={styles.total}>{catalog.owned.length}</span>
        </h1>
        <button type="button" className={common.button} onClick={() => menu.selectPage("market")}>
          マーケットを見る <span aria-hidden="true">↗</span>
        </button>
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
              onClick={() => void refreshOwned()}
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
                すべて <span>{catalog.owned.length}</span>
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
              {entries.length}件{filtering && ` / ${catalog.owned.length}件`}
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
          {sessionItems.extra.length > 0 && (
            <section className={styles.sessionItems} aria-label="セッションに出ているアイテム">
              <h2>セッションに出ている</h2>
              <div className={styles.items} data-layout="list">
                {sessionItems.extra.map(({ placement, item }) => (
                  <SessionItemCard
                    key={placement.id}
                    placement={placement}
                    item={item}
                    who={whoPlaced(session?.participants ?? [], placement.placedBy, me?.id)}
                    canPutAway={canPutAway(placement, me?.id, session?.owner)}
                    onPutAway={() => putAway(placement)}
                    onOpen={item ? () => menu.select("items", item.workId) : undefined}
                  />
                ))}
              </div>
            </section>
          )}
          <div className={styles.items} data-layout={shelf.layout}>
            {entries.map((item) => {
              const outs = sessionItems.onCards.get(item.workId) ?? [];
              const away = outs.filter((placement) =>
                canPutAway(placement, me?.id, session?.owner),
              );
              const removable = away[0];
              return (
                <article
                  key={item.workId}
                  className={styles.card}
                  data-selected={selected?.workId === item.workId}
                  data-out={outs.length > 0 ? "true" : undefined}
                >
                  <button
                    type="button"
                    className={styles.cardOpen}
                    aria-label={`${item.work?.name ?? "利用できないアイテム"} の詳細${outs.length > 0 ? "。セッションに出しています" : ""}`}
                    aria-pressed={selected?.workId === item.workId}
                    onClick={() => menu.select("items", item.workId)}
                  >
                    <ItemThumbnail work={item.work} out={outs.length} />
                    <span className={styles.cardInfo}>
                      <strong>{item.work?.name ?? "利用できないアイテム"}</strong>
                      <span className={common.caption}>{item.work?.ownerName ?? "作者不明"}</span>
                      <span className={styles.version}>
                        v{item.release?.version ?? "?"}
                        {!item.available && <span className={styles.unavailable}>利用不可</span>}
                        {outs.length > 0 && (
                          <span className={styles.outMark}>{outLabel(outs.length)}</span>
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
                    {removable && (
                      <button
                        type="button"
                        className={styles.putAway}
                        aria-label={`${item.work?.name ?? "アイテム"}をセッションから外す`}
                        title={
                          away.length > 1
                            ? `${away.length}個出しています。1個をセッションから外します`
                            : "セッションから外します"
                        }
                        onClick={() => putAway(removable)}
                      >
                        外す
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
        {selected ? (
          <ItemDetails
            key={selected.workId}
            item={selected}
            outs={(sessionItems.onCards.get(selected.workId) ?? []).concat(
              sessionItems.extra
                .filter((entry) => entry.item?.workId === selected.workId)
                .map((entry) => entry.placement),
            )}
            meId={me?.id}
            ownerId={session?.owner}
            participants={session?.participants ?? []}
            onPutAway={putAway}
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

function ItemDetails({
  item,
  outs,
  meId,
  ownerId,
  participants,
  onPutAway,
  onClose,
}: {
  item: OwnedItem;
  outs: PlacementInfo[];
  meId: string | undefined;
  ownerId: string | undefined;
  participants: { id: string; name: string }[];
  onPutAway(placement: PlacementInfo): void;
  onClose(): void;
}) {
  const name = item.work?.name ?? "利用できないアイテム";
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
      <ItemThumbnail work={item.work} out={outs.length} />
      <div className={styles.detailCopy}>
        <span className={styles.typeBadge}>3Dアイテム</span>
        <h2>{name}</h2>
        <p className={common.muted}>作者: {item.work?.ownerName ?? "不明"}</p>
        <dl className={styles.metadata}>
          <dt>所持している版</dt>
          <dd>v{item.release?.version ?? "?"}</dd>
          <dt>入手日</dt>
          <dd>{new Date(item.acquiredAt).toLocaleDateString("ja-JP")}</dd>
        </dl>
        <div className={styles.detailAction}>
          <ItemAction work={item.work} item={item} />
        </div>
        {outs.length > 0 && (
          <div className={styles.outList}>
            <h3>このセッションに出しています</h3>
            <ul>
              {outs.map((placement) => (
                <li key={placement.id}>
                  <span>{whoPlaced(participants, placement.placedBy, meId)}</span>
                  {canPutAway(placement, meId, ownerId) && (
                    <button
                      type="button"
                      aria-label={`${name}をセッションから外す`}
                      onClick={() => onPutAway(placement)}
                    >
                      外す
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {item.work && <WorkTagsEditor work={item.work} />}
      </div>
    </aside>
  );
}

function ItemThumbnail({
  work,
  out = 0,
  label,
}: {
  work: Work | null;
  out?: number;
  label?: string;
}) {
  // サムネイルがあればそれを出す（ADR 0046）
  if (work?.thumbnail)
    return (
      <span className={`${styles.visual} ${styles.visualImage}`} aria-hidden="true">
        <Thumbnail id={work.thumbnail} name={work.name} />
        {out > 0 && <span className={styles.outBadge}>{outLabel(out)}</span>}
      </span>
    );
  return (
    <span className={styles.visual} aria-hidden="true">
      <Glyph kind="box" />
      <span>
        {Array.from(label ?? work?.name ?? "?")
          .slice(0, 2)
          .join("")}
      </span>
      {out > 0 && <span className={styles.outBadge}>{outLabel(out)}</span>}
    </span>
  );
}

function SessionItemCard({
  placement,
  item,
  who,
  canPutAway,
  onPutAway,
  onOpen,
}: {
  placement: PlacementInfo;
  item: OwnedItem | null;
  who: string;
  canPutAway: boolean;
  onPutAway(): void;
  onOpen?(): void;
}) {
  const name = item?.work?.name ?? placement.outputName;
  return (
    <article className={styles.card} data-out="true">
      {onOpen ? (
        <button type="button" className={styles.cardOpen} onClick={onOpen}>
          <ItemThumbnail work={item?.work ?? null} out={1} />
          <SessionItemCopy name={name} who={who} source={placement.workspaceName} />
        </button>
      ) : (
        <div className={styles.cardOpen}>
          <ItemThumbnail work={null} out={1} label={name} />
          <SessionItemCopy name={name} who={who} source={placement.workspaceName} />
        </div>
      )}
      {canPutAway && (
        <div className={styles.cardAction}>
          <button
            type="button"
            className={styles.putAway}
            aria-label={`${name}をセッションから外す`}
            onClick={onPutAway}
          >
            外す
          </button>
        </div>
      )}
    </article>
  );
}

function SessionItemCopy({ name, who, source }: { name: string; who: string; source: string }) {
  return (
    <span className={styles.cardInfo}>
      <strong>{name}</strong>
      <span className={common.caption}>
        {who}が出しています · {source}
      </span>
      <span className={styles.version}>
        <span className={styles.outMark}>出しています</span>
      </span>
    </span>
  );
}

function outLabel(count: number): string {
  return count > 1 ? `${count}個出しています` : "出しています";
}

function canPutAway(
  placement: PlacementInfo,
  meId: string | undefined,
  ownerId: string | undefined,
): boolean {
  return !!meId && (meId === ownerId || meId === placement.placedBy);
}

function whoPlaced(
  participants: { id: string; name: string }[],
  placedBy: string,
  meId: string | undefined,
): string {
  if (placedBy === meId) return "あなた";
  return participants.find((person) => person.id === placedBy)?.name ?? "参加者";
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
