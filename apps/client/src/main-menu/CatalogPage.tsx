import { tagKey } from "@tukurium/shared";
import { type Dispatch, type SetStateAction, useEffect, useId, useState } from "react";
import { useApp } from "../app/store";
import { Thumbnail } from "../app/Thumbnail";
import type { OwnedItem, Work } from "../net/api";
import {
  acquire,
  loadMyWorks,
  loadWork,
  refreshOwned,
  searchMarket,
  takeOut,
  useCatalog,
} from "./catalogStore";
import styles from "./MainMenu.module.css";
import shelfStyles from "./OwnedItemsPage.module.css";
import { useMainMenu } from "./store";
import { WorkTags, WorkTagsEditor } from "./WorkTags";

const KIND_LABEL: Record<string, string> = {
  world: "ワールド",
  item: "アイテム",
  library: "ライブラリ",
};

function kindLabel(kind: string | null | undefined): string {
  return (kind && KIND_LABEL[kind]) || "作品";
}

export function CatalogPage({ active }: { active: boolean }) {
  const menu = useMainMenu();
  const open = useMainMenu((s) => s.open);
  const owner = useCatalog((s) => s.owner);
  const workId = menu.selected.market;
  const [tab, setTab] = useState<"search" | "mine">("search");
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    if (!active || !workId) return;
    void loadWork(workId);
  }, [active, workId]);
  useEffect(() => {
    if (!active || !open || tab !== "mine" || !owner) return;
    void loadMyWorks();
  }, [active, open, tab, owner]);
  if (workId) return <WorkDetail workId={workId} onBack={() => menu.select("market", undefined)} />;
  return (
    <>
      <div className={styles.pageHeader}>
        <h1>マーケット</h1>
      </div>
      <div className={styles.marketTabs} role="tablist" aria-label="マーケット">
        <button
          type="button"
          role="tab"
          className={styles.marketTab}
          aria-selected={tab === "search"}
          onClick={() => setTab("search")}
        >
          さがす
        </button>
        <button
          type="button"
          role="tab"
          className={styles.marketTab}
          aria-selected={tab === "mine"}
          onClick={() => setTab("mine")}
        >
          自分の作品
        </button>
      </div>
      {tab === "mine" ? (
        <MyWorks onOpen={(id) => menu.select("market", id)} />
      ) : (
        <MarketSearch active={active} tags={tags} setTags={setTags} />
      )}
    </>
  );
}

function MarketSearch({
  active,
  tags,
  setTags,
}: {
  active: boolean;
  tags: string[];
  setTags: Dispatch<SetStateAction<string[]>>;
}) {
  const menu = useMainMenu();
  const catalog = useCatalog();
  const status = useApp((s) => s.status);
  const query = menu.queries.market.trim();
  useEffect(() => {
    if (!active || !menu.open || status !== "online" || !catalog.owner) return;
    const timer = setTimeout(() => void searchMarket(query, 0, tags), 200);
    return () => clearTimeout(timer);
  }, [active, menu.open, status, query, catalog.owner, tags]);
  const matches =
    catalog.marketQuery === query && JSON.stringify(catalog.marketTags) === JSON.stringify(tags);
  const entries = matches ? (catalog.market?.items ?? []) : [];
  const loading = catalog.marketLoading || !matches || (!catalog.market && !catalog.marketError);
  const choices = [
    ...new Map(
      [...tags, ...(catalog.market?.items ?? []).flatMap((work) => work.tags ?? [])].map((tag) => [
        tagKey(tag),
        tag,
      ]),
    ).values(),
  ];
  const toggleTag = (tag: string) => {
    setTags((previous) =>
      previous.some((value) => tagKey(value) === tagKey(tag))
        ? previous.filter((value) => tagKey(value) !== tagKey(tag))
        : [...previous, tag].sort(),
    );
  };
  return (
    <>
      <div className={styles.toolbar}>
        <input
          aria-label="マーケットを検索"
          placeholder="アイテム名・作者・タグで検索"
          maxLength={100}
          value={menu.queries.market}
          onChange={(event) => {
            menu.setQuery("market", event.target.value);
            menu.select("market", undefined);
          }}
        />
        <button
          type="button"
          className={styles.button}
          disabled={status !== "online"}
          onClick={() => void searchMarket(query, 0, tags)}
        >
          更新
        </button>
      </div>
      {choices.length > 0 && (
        <fieldset className={shelfStyles.tagFilters}>
          <legend className={shelfStyles.srOnly}>公開タグで絞り込む</legend>
          {choices.map((tag) => (
            <button
              type="button"
              className={shelfStyles.tag}
              key={tag}
              aria-pressed={tags.some((value) => tagKey(value) === tagKey(tag))}
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          ))}
          {tags.length > 0 && (
            <button type="button" className={shelfStyles.textButton} onClick={() => setTags([])}>
              タグを解除
            </button>
          )}
        </fieldset>
      )}
      {status !== "online" && (
        <p className={styles.notice} role="status">
          接続を確認しています。入手・取り出しは接続後に使えます。
        </p>
      )}
      <CatalogNotice />
      {catalog.marketError && (
        <p className={styles.error} role="alert">
          {catalog.marketError}
        </p>
      )}
      {loading && (
        <p className={styles.muted} role="status">
          アイテムを検索しています…
        </p>
      )}
      {!loading && !catalog.marketError && entries.length === 0 && (
        <div className={styles.empty}>
          <p>
            {query || tags.length
              ? "検索に一致するアイテムはありません。"
              : "公開されているアイテムはありません。"}
          </p>
        </div>
      )}
      <div className={styles.itemGrid}>
        {entries.map((work) => {
          const item = catalog.owned.find((entry) => entry.workId === work.id);
          return (
            <article key={work.id} className={styles.itemCard}>
              <button
                className={styles.artButton}
                type="button"
                aria-label={`${work.name} の詳細`}
                onClick={() => menu.select("market", work.id)}
              >
                <ItemArt work={work} />
                {item && <span className={styles.ownedBadge}>所持済み</span>}
              </button>
              <div className={styles.cardCopy}>
                <strong>{work.name}</strong>
                <span className={styles.caption}>{work.ownerName ?? "作者不明"}</span>
                <WorkTags tags={work.tags} onSelect={toggleTag} />
                <ItemAction work={work} item={item} />
              </div>
            </article>
          );
        })}
      </div>
      {catalog.market?.nextOffset != null && !loading && (
        <button
          className={styles.button}
          type="button"
          onClick={() => void searchMarket(query, catalog.market?.nextOffset ?? 0, tags)}
        >
          さらに表示する
        </button>
      )}
    </>
  );
}

function WorkDetail({ workId, onBack }: { workId: string; onBack: () => void }) {
  const detail = useCatalog((s) => (s.detail?.id === workId ? s.detail : null));
  const loading = useCatalog((s) => s.detailLoading);
  const error = useCatalog((s) => s.detailError);
  const item = useCatalog((s) => s.owned.find((entry) => entry.workId === workId));
  const openProject = () => {
    if (detail?.project) useMainMenu.getState().showProject(`/p/${detail.project.id}`);
  };
  return (
    <section className={styles.workDetail} aria-label="作品の詳細">
      <button type="button" className={styles.button} onClick={onBack}>
        一覧へ戻る
      </button>
      {loading && !detail && (
        <p className={styles.muted} role="status">
          作品を読み込んでいます…
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {detail && (
        <>
          <ItemArt work={detail} />
          <div className={styles.pageHeader}>
            <h1>{detail.name}</h1>
            <span className={styles.kindBadge}>{kindLabel(detail.outputKind)}</span>
          </div>
          <p>作者: {detail.ownerName ?? "不明"}</p>
          {detail.project && (
            <p>
              プロジェクト:{" "}
              <button type="button" className={styles.projectLink} onClick={openProject}>
                {detail.project.name}
              </button>
            </p>
          )}
          {detail.outputKind === "item" ? (
            <ItemAction work={detail} item={item} />
          ) : (
            <p className={styles.muted}>入手できるのはアイテムです。</p>
          )}
          <WorkTagsEditor key={detail.id} work={detail} />
          <h2 className={styles.versionHeading}>バージョン · {detail.releases.length}</h2>
          {detail.releases.length === 0 ? (
            <p className={styles.muted}>リリースはまだありません。</p>
          ) : (
            <ol className={styles.versionList}>
              {detail.releases.map((release, index) => (
                <li key={release.id}>
                  <div className={styles.versionHead}>
                    <strong>v{release.version}</strong>
                    {index === 0 && <span className={styles.kindBadge}>最新</span>}
                    <time dateTime={release.createdAt}>
                      {new Date(release.createdAt).toLocaleString("ja-JP")}
                    </time>
                  </div>
                  <p className={styles.versionComment}>
                    {release.comment?.trim() || "コメントはありません"}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function MyWorks({ onOpen }: { onOpen: (id: string) => void }) {
  const owner = useCatalog((s) => s.owner);
  const mine = useCatalog((s) => s.mine);
  const loading = useCatalog((s) => s.mineLoading);
  const error = useCatalog((s) => s.mineError);
  if (!owner) {
    return <p className={styles.muted}>ログインすると、自分の作品を見られます。</p>;
  }
  return (
    <>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {loading && mine.length === 0 && (
        <p className={styles.muted} role="status">
          作品を読み込んでいます…
        </p>
      )}
      {!loading && !error && mine.length === 0 && (
        <div className={styles.empty}>
          <p>公開した作品はまだありません。</p>
        </div>
      )}
      <ul className={styles.workList}>
        {mine.map((work) => (
          <li key={work.id}>
            <button type="button" onClick={() => onOpen(work.id)}>
              <strong>{work.name}</strong>
              <span>{kindLabel(work.outputKind)}</span>
              <span>{work.latest ? `v${work.latest.version}` : "リリースなし"}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ItemAction({ work, item }: { work: Work | null; item?: OwnedItem }) {
  const { busy, ownedLoaded, ownedError, retry } = useCatalog();
  const { session, status, me } = useApp();
  const reasonId = useId();
  const allowed = !!work && (work.perms.use || work.owner === me?.id);
  const unavailable = item ? !item.available : !work?.latest || !allowed;
  const reason = unavailable
    ? (item?.reason ?? (!work?.latest ? "リリースがありません" : "利用する権限がありません"))
    : status !== "online"
      ? "接続を待っています"
      : !ownedLoaded
        ? ownedError
          ? "所持一覧を再読み込みしてください"
          : "所持アイテムを確認しています…"
        : retry
          ? "前の取り出し結果を確認してください"
          : busy
            ? "操作の完了を待っています…"
            : null;
  return (
    <>
      <button
        type="button"
        className={styles.primary}
        disabled={!!reason}
        title={reason ?? undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => (item ? void takeOut(item) : work && void acquire(work))}
      >
        {busy === work?.id
          ? "処理しています…"
          : item
            ? session
              ? "取り出す"
              : "セッションを選ぶ"
            : "入手する"}
      </button>
      {reason && (
        <span className={styles.caption} id={reasonId}>
          {reason}
        </span>
      )}
    </>
  );
}

export function ItemDetailsPlaceholder({ className = styles.detail }: { className?: string }) {
  return (
    <aside className={className} aria-label="アイテムの詳細">
      <div className={styles.detailPlaceholder}>
        <svg
          viewBox="0 0 24 24"
          width="42"
          height="42"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          aria-hidden="true"
        >
          <path d="m3 7 9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10" />
        </svg>
        <h2>アイテムを選択</h2>
        <p>一覧から選ぶと、詳細がここに表示されます。</p>
      </div>
    </aside>
  );
}

export function CatalogNotice() {
  const { message, actionError, retry, owned, busy, ownedError } = useCatalog();
  const status = useApp((s) => s.status);
  const item = retry ? owned.find((i) => i.workId === retry.workId) : undefined;
  return (
    <>
      {ownedError && (
        <p role="alert" className={styles.error}>
          {ownedError}{" "}
          <button type="button" className={styles.button} onClick={() => void refreshOwned()}>
            所持一覧を再読み込み
          </button>
        </p>
      )}
      {message && (
        <p className={styles.notice} role="status">
          {message}
        </p>
      )}
      {actionError && (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      )}
      {retry && item && (
        <div className={styles.toolbar}>
          <button
            type="button"
            className={styles.button}
            disabled={!!busy || status !== "online"}
            onClick={() => void takeOut(item, retry)}
          >
            結果を確認
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => useCatalog.setState({ retry: null, actionError: null })}
          >
            配置を確認した
          </button>
        </div>
      )}
    </>
  );
}

/** アイテムの絵：サムネイルがあればそれ、なければ箱の絵（ADR 0046） */
export function ItemArt({ work }: { work?: Work | null }) {
  if (work?.thumbnail)
    return (
      <div className={`${styles.itemArt} ${styles.itemArtImage}`}>
        <Thumbnail id={work.thumbnail} name={work.name} />
      </div>
    );
  return (
    <div className={styles.itemArt}>
      <svg viewBox="0 0 120 90" width="100%" height="100%" aria-hidden="true">
        <path d="M60 15 94 33 60 52 26 33Z" fill="#e5d8e2" />
        <path d="m26 33 34 19v35L26 68Z" fill="#bda8b7" />
        <path d="m60 52 34-19v35L60 87Z" fill="#94788c" />
        <path
          d="m60 15 34 18v35L60 87 26 68V33Z M26 33l34 19 34-19M60 52v35"
          fill="none"
          stroke="#603d56"
          strokeWidth="1.2"
        />
      </svg>
      <span>プレビュー未設定</span>
    </div>
  );
}
