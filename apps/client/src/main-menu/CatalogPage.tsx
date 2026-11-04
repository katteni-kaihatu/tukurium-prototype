import { useEffect } from "react";
import { useApp } from "../app/store";
import type { OwnedItem, Work } from "../net/api";
import { acquire, refreshOwned, searchMarket, takeOut, useCatalog } from "./catalogStore";
import styles from "./MainMenu.module.css";
import { useMainMenu } from "./store";

export function CatalogPage({ kind, active }: { kind: "items" | "market"; active: boolean }) {
  const menu = useMainMenu();
  const catalog = useCatalog();
  const status = useApp((s) => s.status);
  const query = menu.queries[kind].trim();
  const market = kind === "market";
  useEffect(() => {
    if (!active || !menu.open || status !== "online" || !catalog.owner) return;
    if (market) {
      const timer = setTimeout(() => void searchMarket(query), 200);
      return () => clearTimeout(timer);
    }
  }, [active, menu.open, status, market, query, catalog.owner]);
  const owned = catalog.owned.filter((i) =>
    `${i.work?.name ?? ""} ${i.work?.ownerName ?? ""}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const entries: { work: Work | null; item?: OwnedItem; id: string }[] = market
    ? (catalog.marketQuery === query ? (catalog.market?.items ?? []) : []).map((work) => ({
        work,
        id: work.id,
        item: catalog.owned.find((i) => i.workId === work.id),
      }))
    : owned.map((item) => ({ work: item.work, id: item.workId, item }));
  const selected = entries.find((e) => e.id === menu.selected[kind]);
  const loading = market
    ? catalog.marketLoading ||
      catalog.marketQuery !== query ||
      (!catalog.market && !catalog.marketError)
    : catalog.ownedLoading;
  const error = market ? catalog.marketError : catalog.ownedError;
  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1>{market ? "マーケット" : "アイテム"}</h1>
          <p className={styles.muted}>
            {market
              ? "公開されたアイテムを探して、自分の所持品に。"
              : "入手したアイテムを、いまいる場所へ。"}
          </p>
        </div>
        <span className={styles.caption}>
          {market ? "無料で入手" : `${catalog.owned.length}個の所持アイテム`}
        </span>
      </div>
      <div className={styles.toolbar}>
        <input
          aria-label={market ? "マーケットを検索" : "所持アイテムを検索"}
          placeholder="アイテム名・作者で検索"
          maxLength={100}
          value={menu.queries[kind]}
          onChange={(e) => {
            menu.setQuery(kind, e.target.value);
            menu.select(kind, undefined);
          }}
        />
        <button
          type="button"
          className={styles.button}
          disabled={status !== "online"}
          onClick={() => void (market ? searchMarket(query) : refreshOwned())}
        >
          更新
        </button>
      </div>
      {status !== "online" && (
        <p className={styles.notice} role="status">
          接続を確認しています。入手・取り出しは接続後に使えます。
        </p>
      )}
      <CatalogNotice />
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p className={styles.muted} role="status">
          {market ? "アイテムを検索しています…" : "所持アイテムを確認しています…"}
        </p>
      )}
      {!loading && !error && entries.length === 0 && (
        <div className={styles.empty}>
          <p>
            {query
              ? "検索に一致するアイテムはありません。"
              : market
                ? "公開されているアイテムはありません。"
                : "まだアイテムを所持していません。"}
          </p>
          {!market && (
            <button
              className={styles.button}
              type="button"
              onClick={() => menu.selectPage("market")}
            >
              マーケットを見る
            </button>
          )}
        </div>
      )}
      <div className={selected ? styles.catalogSplit : undefined}>
        <div className={styles.itemGrid}>
          {entries.map(({ id, work, item }) => (
            <article
              key={id}
              className={styles.itemCard}
              data-selected={selected?.id === id || undefined}
            >
              <button
                className={styles.artButton}
                type="button"
                aria-label={`${work?.name ?? "利用できないアイテム"} の詳細`}
                onClick={() => menu.select(kind, id)}
              >
                <ItemArt />
                {item && <span className={styles.ownedBadge}>所持済み</span>}
              </button>
              <div className={styles.cardCopy}>
                <strong>{work?.name ?? "利用できないアイテム"}</strong>
                <span className={styles.caption}>{work?.ownerName ?? "作者不明"}</span>
                <ItemAction work={work} item={item} />
              </div>
            </article>
          ))}
        </div>
        {selected && (
          <aside className={styles.detail} aria-label="アイテムの詳細">
            <button
              type="button"
              className={styles.button}
              onClick={() => menu.select(kind, undefined)}
            >
              一覧に戻る
            </button>
            <ItemArt />
            <h2>{selected.work?.name ?? "利用できないアイテム"}</h2>
            <p>作者: {selected.work?.ownerName ?? "不明"}</p>
            <p className={styles.muted}>
              {selected.item
                ? `所持している版: v${selected.item.release?.version ?? "?"}`
                : `公開されている版: ${selected.work?.latest ? `v${selected.work.latest.version}` : "リリースなし"}`}
            </p>
            {selected.item?.reason && <p className={styles.error}>{selected.item.reason}</p>}
            <ItemAction work={selected.work} item={selected.item} />
          </aside>
        )}
      </div>
      {market && catalog.market?.nextOffset != null && !loading && (
        <button
          className={styles.button}
          type="button"
          onClick={() => void searchMarket(query, catalog.market?.nextOffset ?? 0)}
        >
          さらに表示する
        </button>
      )}
    </>
  );
}

export function ItemAction({ work, item }: { work: Work | null; item?: OwnedItem }) {
  const { busy, ownedLoaded, retry } = useCatalog();
  const { session, status, me } = useApp();
  const allowed = !!work && (work.perms.use || work.owner === me?.id);
  const unavailable = item ? !item.available : !work?.latest || !allowed;
  const disabled = !!busy || !!retry || status !== "online" || unavailable || !ownedLoaded;
  return (
    <>
      <button
        type="button"
        className={styles.primary}
        disabled={disabled}
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
      {unavailable && (
        <span className={styles.caption}>
          {item?.reason ?? (!work?.latest ? "リリースがありません" : "利用する権限がありません")}
        </span>
      )}
    </>
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

export function ItemArt() {
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
