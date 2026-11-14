import { MAX_WORK_TAG_LENGTH, MAX_WORK_TAGS, tagKey } from "@tukurium/shared";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useApp } from "../app/store";
import { Thumbnail } from "../app/Thumbnail";
import {
  api,
  type MarketEvent,
  type MarketKind,
  type MarketSort,
  type MyMarket,
  type OwnedItem,
  type Release,
  type Work,
  type WorkDetail,
} from "../net/api";
import {
  acquire,
  loadMyWorks,
  loadWallet,
  loadWork,
  refreshOwned,
  saveListing,
  searchMarket,
  takeOut,
  unlistWork,
  useCatalog,
} from "./catalogStore";
import styles from "./MainMenu.module.css";
import m from "./Market.module.css";
import { useMainMenu } from "./store";

const KIND_LABEL: Record<string, string> = {
  world: "ワールド",
  item: "アイテム",
  library: "ライブラリ",
};

function kindLabel(kind: string | null | undefined): string {
  return (kind && KIND_LABEL[kind]) || "リリース";
}

/** 価格の書き方。0 は「無料」 */
export function priceLabel(price: number) {
  return price === 0 ? "無料" : `${price.toLocaleString("ja-JP")} P`;
}

const dateLabel = (at: string) =>
  new Date(at).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });

export function CatalogPage({ active }: { active: boolean }) {
  const menu = useMainMenu();
  const open = useMainMenu((s) => s.open);
  const owner = useCatalog((s) => s.owner);
  const balance = useCatalog((s) => s.balance);
  const workId = menu.selected.market;
  const [tab, setTab] = useState<"search" | "mine">("search");
  useEffect(() => {
    if (!active || !workId) return;
    void loadWork(workId);
  }, [active, workId]);
  useEffect(() => {
    if (!active || !open || !owner) return;
    void loadWallet();
  }, [active, open, owner]);
  useEffect(() => {
    if (!active || !open || tab !== "mine" || !owner) return;
    void loadMyWorks();
  }, [active, open, tab, owner]);
  const choose = (next: "search" | "mine") => {
    setTab(next);
    menu.select("market", undefined);
  };
  return (
    <div className={m.market}>
      <div className={m.bar}>
        <label className={m.search}>
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l5 5" />
          </svg>
          <span className={m.srOnly}>マーケットを検索</span>
          <input
            placeholder="作品名・制作者・タグで検索"
            maxLength={100}
            value={menu.queries.market}
            onChange={(event) => {
              menu.setQuery("market", event.target.value);
              menu.select("market", undefined);
              setTab("search");
            }}
          />
        </label>
        <span className={m.grow} />
        <div className={m.tabs} role="tablist" aria-label="マーケットの画面">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "search"}
            onClick={() => choose("search")}
          >
            さがす
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "mine"}
            onClick={() => choose("mine")}
          >
            マイページ
          </button>
        </div>
        {owner && (
          <span className={m.points} title="持っているポイント">
            <b>{balance === null ? "…" : balance.toLocaleString("ja-JP")}</b> P
          </span>
        )}
      </div>
      {workId ? (
        <WorkDetailView workId={workId} onBack={() => menu.select("market", undefined)} />
      ) : tab === "mine" ? (
        <MyPage onOpen={(id) => menu.select("market", id)} />
      ) : (
        <MarketSearch active={active} />
      )}
    </div>
  );
}

const KINDS: [MarketKind, string][] = [
  ["all", "すべて"],
  ["item", "アイテム"],
  ["world", "ワールド"],
];
const SORTS: [MarketSort, string][] = [
  ["new", "新着順"],
  ["popular", "人気順"],
  ["cheap", "安い順"],
];

function MarketSearch({ active }: { active: boolean }) {
  const menu = useMainMenu();
  const catalog = useCatalog();
  const status = useApp((s) => s.status);
  const query = menu.queries.market.trim();
  const [tags, setTags] = useState<string[]>(catalog.marketTags);
  const [kind, setKind] = useState<MarketKind>(catalog.marketKind);
  const [sort, setSort] = useState<MarketSort>(catalog.marketSort);
  useEffect(() => {
    if (!active || !menu.open || status !== "online" || !catalog.owner) return;
    const timer = setTimeout(() => void searchMarket(query, 0, tags, { kind, sort }), 200);
    return () => clearTimeout(timer);
  }, [active, menu.open, status, query, catalog.owner, tags, kind, sort]);
  const matches =
    catalog.marketQuery === query &&
    JSON.stringify(catalog.marketTags) === JSON.stringify(tags) &&
    catalog.marketKind === kind &&
    catalog.marketSort === sort;
  const entries = matches ? (catalog.market?.items ?? []) : [];
  const loading = catalog.marketLoading || !matches || (!catalog.market && !catalog.marketError);
  const choices = [
    ...new Map(
      [...tags, ...(catalog.market?.items ?? []).flatMap((work) => work.tags ?? [])].map((tag) => [
        tagKey(tag),
        tag,
      ]),
    ).values(),
  ].slice(0, 12);
  const toggleTag = (tag: string) => {
    setTags((previous) =>
      previous.some((value) => tagKey(value) === tagKey(tag))
        ? previous.filter((value) => tagKey(value) !== tagKey(tag))
        : [...previous, tag].sort(),
    );
  };
  return (
    <>
      <div className={m.filters}>
        <div className={m.kinds} role="radiogroup" aria-label="種類">
          {KINDS.map(([value, label]) => (
            // biome-ignore lint/a11y/useSemanticElements: 見た目どおりの丸いボタンで種類を選ぶ
            <button
              type="button"
              role="radio"
              key={value}
              aria-checked={kind === value}
              data-kind={value}
              onClick={() => setKind(value)}
            >
              {value !== "all" && <span className={m.dot} aria-hidden="true" />}
              {label}
            </button>
          ))}
        </div>
        {choices.length > 0 && (
          <>
            <span className={m.divider} aria-hidden="true" />
            <fieldset className={m.tagFilter}>
              <legend className={m.srOnly}>タグで絞り込む</legend>
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 4h8l10 10-7 7L3 10z" />
              </svg>
              {choices.map((tag) => (
                <button
                  type="button"
                  key={tag}
                  aria-pressed={tags.some((value) => tagKey(value) === tagKey(tag))}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </fieldset>
          </>
        )}
        <span className={m.grow} />
        <label className={m.sort}>
          並べ替え
          <select value={sort} onChange={(e) => setSort(e.target.value as MarketSort)}>
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={m.body}>
        {status !== "online" && (
          <p className={styles.notice} role="status">
            接続を確認しています。入手は接続後に使えます。
          </p>
        )}
        <CatalogNotice />
        {catalog.marketError && (
          <p className={styles.error} role="alert">
            {catalog.marketError}
          </p>
        )}
        {loading ? (
          <p className={styles.muted} role="status">
            マーケットを検索しています…
          </p>
        ) : (
          <span className={m.count}>
            {catalog.market?.total ?? 0} 件 ·{" "}
            {kind === "all" ? "アイテム・ワールド" : kindLabel(kind)}
          </span>
        )}
        {!loading && !catalog.marketError && entries.length === 0 && (
          <div className={styles.empty}>
            <p>
              {query || tags.length || kind !== "all"
                ? "検索に一致する作品はありません。"
                : "マーケットに登録された作品はまだありません。マイページから登録できます。"}
            </p>
          </div>
        )}
        <div className={m.grid}>
          {entries.map((work) => (
            <WorkCard
              key={work.id}
              work={work}
              owned={catalog.owned.some((entry) => entry.workId === work.id)}
              onOpen={() => menu.select("market", work.id)}
            />
          ))}
        </div>
        {catalog.market?.nextOffset != null && !loading && (
          <button
            className={styles.button}
            type="button"
            onClick={() =>
              void searchMarket(query, catalog.market?.nextOffset ?? 0, tags, { kind, sort })
            }
          >
            さらに表示する
          </button>
        )}
      </div>
    </>
  );
}

function WorkCard({ work, owned, onOpen }: { work: Work; owned: boolean; onOpen(): void }) {
  const price = work.market?.price ?? 0;
  return (
    <button type="button" className={m.card} aria-label={`${work.name} の詳細`} onClick={onOpen}>
      <span className={m.cardArt} data-kind={work.outputKind ?? "item"}>
        <WorkArt work={work} size={40} />
        <span className={m.kindTag}>{kindLabel(work.outputKind)}</span>
        {owned && <span className={m.ownedTag}>✓ 所持済み</span>}
      </span>
      <span className={m.cardCopy}>
        <b>{work.name}</b>
        <span className={m.author}>{work.ownerName ?? "作者不明"}</span>
        <span className={m.price} data-free={price === 0 || undefined}>
          {priceLabel(price)}
        </span>
      </span>
    </button>
  );
}

const KIND_ICON: Record<string, string> = {
  item: "M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10",
  world: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
};

/** カードの絵：サムネイルがあればそれ、なければ種類の絵 */
export function WorkArt({ work, size }: { work: Work; size: number }) {
  if (work.thumbnail) return <Thumbnail id={work.thumbnail} name={work.name} />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={KIND_ICON[work.outputKind ?? "item"] ?? KIND_ICON.item} />
    </svg>
  );
}

function historyText(event: MarketEvent) {
  switch (event.kind) {
    case "listed":
      return `マーケットに登録（v${event.version}・${priceLabel(event.price)}）`;
    case "published":
      return `v${event.version} を公開${event.auto ? "（自動公開）" : ""}`;
    case "price":
      return `価格を ${priceLabel(event.from)} から ${priceLabel(event.to)} に変更`;
    case "unlisted":
      return "マーケットの登録を取り消し";
  }
}

function WorkDetailView({ workId, onBack }: { workId: string; onBack: () => void }) {
  const detail = useCatalog((s) => (s.detail?.id === workId ? s.detail : null));
  const loading = useCatalog((s) => s.detailLoading);
  const error = useCatalog((s) => s.detailError);
  const item = useCatalog((s) => s.owned.find((entry) => entry.workId === workId));
  const [editing, setEditing] = useState(false);
  const me = useApp((s) => s.me?.id);
  const openProject = () => {
    if (detail?.project) useMainMenu.getState().showProject(`/p/${detail.project.id}`);
  };
  return (
    <div className={m.body}>
      <button type="button" className={m.back} onClick={onBack}>
        ← 一覧へ戻る
      </button>
      <CatalogNotice />
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
        <section className={m.detail} aria-label={`${detail.name} の詳細`}>
          <div className={m.detailTop}>
            <span className={m.hero} data-kind={detail.outputKind ?? "item"}>
              <WorkArt work={detail} size={72} />
            </span>
            <div className={m.summary}>
              <span className={m.kindBadge} data-kind={detail.outputKind ?? "item"}>
                <span className={m.dot} aria-hidden="true" />
                {kindLabel(detail.outputKind)}
              </span>
              <h1>{detail.name}</h1>
              <span className={m.byline}>
                <span className={m.initial} aria-hidden="true">
                  {(detail.ownerName ?? "?").slice(0, 1)}
                </span>
                {detail.ownerName ?? "作者不明"}
              </span>
              <BuyBox work={detail} item={item} onEdit={() => setEditing(true)} />
              {!!detail.tags?.length && (
                <div className={m.tagBlock}>
                  <span className={m.label}>タグ</span>
                  <div className={m.tagList}>
                    {detail.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
              )}
              <span className={m.meta}>
                {detail.project ? (
                  <>
                    プロジェクト：
                    <button type="button" className={m.link} onClick={openProject}>
                      {detail.ownerName} / {detail.project.name}
                    </button>
                    {" · "}
                  </>
                ) : null}
                {detail.latest
                  ? `最新 v${detail.latest.version} · ${dateLabel(detail.latest.createdAt)}に公開`
                  : "まだリリースがありません"}
              </span>
            </div>
          </div>
          <div className={m.columns}>
            <section aria-label="バージョン">
              <h2>
                バージョン <span>{detail.releases.length}</span>
              </h2>
              {detail.releases.length === 0 ? (
                <p className={styles.muted}>バージョンはまだありません。</p>
              ) : (
                <ol className={m.versions}>
                  {detail.releases.map((release, index) => (
                    <li key={release.id}>
                      <b>v{release.version}</b>
                      <span>
                        <span>{release.comment?.trim() || "コメントはありません"}</span>
                        <time dateTime={release.createdAt}>{dateLabel(release.createdAt)}</time>
                      </span>
                      {detail.market?.release?.id === release.id ? (
                        <span className={m.badge}>公開中</span>
                      ) : index === 0 ? (
                        <span className={m.badgeQuiet}>最新</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section aria-label="履歴">
              <h2>履歴</h2>
              {detail.history.length === 0 ? (
                <p className={styles.muted}>マーケットの履歴はまだありません。</p>
              ) : (
                <ol className={m.history}>
                  {detail.history.map((event) => (
                    <li key={event.id} data-kind={event.kind}>
                      <span className={m.historyDot} aria-hidden="true" />
                      <span>
                        <span>{historyText(event)}</span>
                        <time dateTime={event.at}>{dateLabel(event.at)}</time>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        </section>
      )}
      {editing && detail && detail.owner === me && (
        <ListingDialog works={[detail]} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

/** 価格と入手のボタン。持っていれば、取り出す（アイテム）・開く（ワールド） */
function BuyBox({ work, item, onEdit }: { work: WorkDetail; item?: OwnedItem; onEdit(): void }) {
  const me = useApp((s) => s.me?.id);
  const status = useApp((s) => s.status);
  const { busy, balance, ownedLoaded } = useCatalog();
  const reasonId = useId();
  const own = work.owner === me;
  if (!work.market)
    return (
      <div className={m.buy}>
        <span className={m.buyNote}>
          {own
            ? "マーケットに登録していません。登録すると、ほかの人が入手できるようになります。"
            : "この作品はマーケットに登録されていません。"}
        </span>
        {own && (
          <button type="button" className={m.primary} onClick={onEdit}>
            登録する
          </button>
        )}
      </div>
    );
  const price = work.market.price;
  const version = work.market.release?.version;
  const short = !own && !item && balance !== null && balance < price;
  const reason =
    status !== "online"
      ? "接続を待っています"
      : !ownedLoaded
        ? "所持アイテムを確認しています…"
        : short
          ? `ポイントが ${(price - (balance ?? 0)).toLocaleString("ja-JP")} P 足りません`
          : busy
            ? "操作の完了を待っています…"
            : null;
  return (
    <div className={m.buy}>
      <span className={m.priceBlock}>
        <span>価格</span>
        <b data-free={price === 0 || undefined}>{priceLabel(price)}</b>
      </span>
      <span className={m.buyNote} id={reasonId}>
        {item
          ? `所持しています（v${item.release?.version ?? "?"}）。`
          : `入手すると v${version ?? "?"} が${work.outputKind === "world" ? "ワールドで開けるように" : "所持アイテムに入り"}ます。`}
        <br />
        {own
          ? "自分の作品です。"
          : `持っているポイント：${balance === null ? "…" : `${balance.toLocaleString("ja-JP")} P`}`}
        {reason && !item && (
          <>
            <br />
            <span className={short ? m.warn : undefined}>{reason}</span>
          </>
        )}
      </span>
      {own && (
        <button type="button" className={m.secondary} onClick={onEdit}>
          登録を編集
        </button>
      )}
      {item ? (
        <ItemAction work={work} item={item} />
      ) : (
        <button
          type="button"
          className={m.primary}
          disabled={!!reason}
          aria-describedby={reasonId}
          onClick={() => void acquire(work)}
        >
          {busy === work.id ? "処理しています…" : "入手する"}
        </button>
      )}
    </div>
  );
}

function MyPage({ onOpen }: { onOpen: (id: string) => void }) {
  const owner = useCatalog((s) => s.owner);
  const mine = useCatalog((s) => s.mine);
  const loading = useCatalog((s) => s.mineLoading);
  const error = useCatalog((s) => s.mineError);
  const [dialog, setDialog] = useState<"new" | Work | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  if (!owner) {
    return (
      <div className={m.body}>
        <p className={styles.muted}>ログインすると、自分の作品を登録できます。</p>
      </div>
    );
  }
  const toggleAuto = async (work: Work) => {
    setToggling(work.id);
    setToggleError(null);
    try {
      await saveListing(work, { autoPublish: !work.market?.autoPublish });
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : "変えられませんでした");
    } finally {
      setToggling(null);
    }
  };
  return (
    <div className={m.body}>
      <div className={m.mineHead}>
        <h2>
          自分の作品 <span>{mine?.listed.length ?? 0}</span>
        </h2>
        <span className={m.grow} />
        <button type="button" className={m.primary} onClick={() => setDialog("new")}>
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          登録する
        </button>
      </div>
      <CatalogNotice />
      {(error || toggleError) && (
        <p className={styles.error} role="alert">
          {error ?? toggleError}
        </p>
      )}
      {loading && !mine && (
        <p className={styles.muted} role="status">
          自分の作品を読み込んでいます…
        </p>
      )}
      {mine && mine.listed.length === 0 && (
        <div className={styles.empty}>
          <p>
            マーケットに登録した作品はまだありません。「登録する」から、プロジェクトのリリースを選んで登録できます。
          </p>
        </div>
      )}
      {mine && mine.listed.length > 0 && (
        <div className={m.tableWrap}>
          <table className={m.table} aria-label="自分の作品">
            <thead>
              <tr>
                <th scope="col">作品</th>
                <th scope="col">種類</th>
                <th scope="col">価格</th>
                <th scope="col">公開中のバージョン</th>
                <th scope="col">自動公開</th>
                <th scope="col">入手</th>
                <th scope="col">
                  <span className={m.srOnly}>操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {mine.listed.map((work) => {
                const published = work.market?.release;
                const behind = !!work.latest && published?.id !== work.latest.id;
                const auto = !!work.market?.autoPublish;
                return (
                  <tr key={work.id}>
                    <td>
                      <div className={m.workCell}>
                        <span className={m.thumb} data-kind={work.outputKind ?? "item"}>
                          <WorkArt work={work} size={20} />
                        </span>
                        <span>
                          <button type="button" className={m.link} onClick={() => onOpen(work.id)}>
                            <b>{work.name}</b>
                          </button>
                          <small>{work.repoName}</small>
                        </span>
                      </div>
                    </td>
                    <td className={m.kindText} data-kind={work.outputKind ?? "item"}>
                      {kindLabel(work.outputKind)}
                    </td>
                    <td>
                      <b>{priceLabel(work.market?.price ?? 0)}</b>
                    </td>
                    <td>
                      {published ? `v${published.version}` : "—"}
                      {behind && work.latest && (
                        <small className={m.warn}>新しい v{work.latest.version} があります</small>
                      )}
                    </td>
                    <td>
                      <div className={m.switchCell}>
                        <button
                          type="button"
                          role="switch"
                          className={m.switch}
                          aria-checked={auto}
                          aria-label={`${work.name} を自動公開`}
                          disabled={toggling === work.id}
                          onClick={() => void toggleAuto(work)}
                        >
                          <span />
                        </button>
                        <small>{auto ? "オン" : "オフ"}</small>
                      </div>
                    </td>
                    <td>{work.market?.acquisitions ?? 0} 人</td>
                    <td>
                      <button type="button" className={m.small} onClick={() => setDialog(work)}>
                        編集
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {mine && <SalesLog mine={mine} />}
      {dialog && mine && (
        <ListingDialog
          works={dialog === "new" ? mine.unlisted : [dialog]}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/** 入手の記録。誰が入手したかは出さない */
function SalesLog({ mine }: { mine: MyMarket }) {
  const earned = mine.sales.reduce((sum, sale) => sum + sale.earned, 0);
  return (
    <section className={m.sales} aria-label="入手の記録">
      <div className={m.mineHead}>
        <h2>
          入手の記録 <span>{mine.sales.length}</span>
        </h2>
        <span className={m.grow} />
        <span className={m.salesTotal}>受け取ったポイント：{earned.toLocaleString("ja-JP")} P</span>
      </div>
      <p className={m.hint}>
        価格の 9 割があなたのポイントになります。誰が入手したかは表示しません。
      </p>
      {mine.sales.length === 0 ? (
        <p className={styles.muted}>まだ入手されていません。</p>
      ) : (
        <ol className={m.salesList}>
          {mine.sales.map((sale) => (
            <li key={sale.id}>
              <time dateTime={sale.at}>{new Date(sale.at).toLocaleString("ja-JP")}</time>
              <span>
                「{sale.workName}」{sale.version ? ` v${sale.version}` : ""} が入手されました
              </span>
              <span>{priceLabel(sale.price)}</span>
              <b>+{sale.earned.toLocaleString("ja-JP")} P</b>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * マーケットに登録する・登録を変えるダイアログ。
 * works が一件で、すでに登録されていれば編集。そうでなければリリースを選んで登録する。
 */
function ListingDialog({ works, onClose }: { works: Work[]; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const editing = works.length === 1 && works[0]?.market ? works[0] : null;
  const choices = works.filter((w) => !w.market);
  const firstReady = choices.find((w) => w.latest)?.id ?? null;
  const [workId, setWorkId] = useState<string | null>(editing?.id ?? firstReady);
  const work = editing ?? choices.find((w) => w.id === workId) ?? null;
  const [price, setPrice] = useState(String(editing?.market?.price ?? 0));
  const [tags, setTags] = useState<string[]>(work?.tags ?? []);
  const [auto, setAuto] = useState(editing?.market?.autoPublish ?? true);
  const [releaseId, setReleaseId] = useState<string | null>(
    editing?.market?.release?.id ?? work?.latest?.id ?? null,
  );
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const priceId = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  useEffect(() => {
    if (!work?.id) return;
    let alive = true;
    setReleases(null);
    api.work(work.id).then(
      (detail) => alive && setReleases(detail.releases),
      () => alive && setReleases([]),
    );
    return () => {
      alive = false;
    };
  }, [work?.id]);
  const pick = (next: Work) => {
    setWorkId(next.id);
    setTags(next.tags ?? []);
    setReleaseId(next.latest?.id ?? null);
  };
  const value = Number(price);
  const priceValid = /^\d{1,6}$/.test(price.trim()) && value <= 100000;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!work || !priceValid) return;
    setBusy(true);
    setError(null);
    try {
      await saveListing(work, {
        price: value,
        tags,
        autoPublish: auto,
        ...(auto || !releaseId ? {} : { releaseId }),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "登録できませんでした");
    } finally {
      setBusy(false);
    }
  };
  const unlist = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await unlistWork(editing);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "取り消せませんでした");
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      className={m.dialog}
      aria-label={editing ? "登録を編集" : "マーケットに登録"}
      data-workspace-popover
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form className={m.dialogBody} onSubmit={(e) => void submit(e)}>
        <div className={m.dialogHead}>
          <h2>{editing ? "登録を編集" : "マーケットに登録"}</h2>
          <span>{editing ? editing.name : "プロジェクトのリリースから選ぶ"}</span>
          <span className={m.grow} />
          <button type="button" className={m.close} aria-label="閉じる" onClick={onClose}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {!editing && (
          <fieldset className={m.releases}>
            <legend>登録するリリース</legend>
            {choices.length === 0 && (
              <p className={m.hint}>
                登録できる作品がありません。プロジェクトでアイテムやワールドをリリースすると、ここに出ます。
              </p>
            )}
            {choices.map((choice) => (
              <label key={choice.id} data-disabled={!choice.latest || undefined}>
                <input
                  type="radio"
                  name="release"
                  checked={workId === choice.id}
                  disabled={!choice.latest}
                  onChange={() => pick(choice)}
                />
                <span>
                  <b>
                    {choice.name} <span>· {choice.repoName}</span>
                  </b>
                  <small>
                    {choice.latest
                      ? `最新のリリース v${choice.latest.version} · ${dateLabel(choice.latest.createdAt)} · まだ登録していません`
                      : "まだリリースがありません"}
                  </small>
                </span>
                <span className={m.kindText} data-kind={choice.outputKind ?? "item"}>
                  {kindLabel(choice.outputKind)}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className={m.fields}>
          <div className={m.field}>
            <label htmlFor={priceId}>価格</label>
            <span className={m.priceInput}>
              <input
                id={priceId}
                value={price}
                inputMode="numeric"
                aria-invalid={!priceValid || undefined}
                onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ""))}
              />
              <b>P</b>
            </span>
            <small className={priceValid ? m.free : m.warn}>
              {!priceValid
                ? "0〜100,000 の数で入れてください"
                : value === 0
                  ? "0 P は無料になります"
                  : `売れると ${Math.floor(value * 0.9).toLocaleString("ja-JP")} P があなたに入ります`}
            </small>
          </div>
          <TagInput value={tags} onChange={setTags} />
        </div>
        <div className={m.autoBox}>
          <button
            type="button"
            role="switch"
            className={m.switch}
            aria-checked={auto}
            aria-label="自動公開"
            onClick={() => setAuto(!auto)}
          >
            <span />
          </button>
          <span>
            <b>自動公開</b>
            <span>
              プロジェクトで新しいバージョンをリリースしたとき、マーケットにも自動で公開します。切ると、公開するバージョンを自分で選びます。
            </span>
            {!auto && (
              <label className={m.versionPick}>
                公開するバージョン
                <select
                  value={releaseId ?? ""}
                  onChange={(e) => setReleaseId(e.target.value || null)}
                  disabled={!releases}
                >
                  {(releases ?? (work?.latest ? [work.latest] : [])).map((release) => (
                    <option key={release.id} value={release.id}>
                      v{release.version} · {dateLabel(release.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </span>
        </div>
        {error && (
          <p className={m.warn} role="alert">
            {error}
          </p>
        )}
        <span className={m.grow} />
        <div className={m.dialogFoot}>
          {editing && (
            <button
              type="button"
              className={m.danger}
              disabled={busy}
              onClick={() => void unlist()}
            >
              登録を取り消す
            </button>
          )}
          <span className={m.grow} />
          <button type="button" className={m.secondary} onClick={onClose}>
            キャンセル
          </button>
          <button
            type="submit"
            className={m.primary}
            disabled={busy || !work || !work.latest || !priceValid}
          >
            {busy ? "保存しています…" : editing ? "保存する" : "登録する"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** タグを一つずつ足す欄。Enter・読点・カンマで確定、空のまま Backspace で最後を消す */
function TagInput({ value, onChange }: { value: string[]; onChange(next: string[]): void }) {
  const [draft, setDraft] = useState("");
  const id = useId();
  const add = (raw: string) => {
    const tag = raw.trim().slice(0, MAX_WORK_TAG_LENGTH);
    if (!tag || value.length >= MAX_WORK_TAGS) return;
    if (value.some((t) => tagKey(t) === tagKey(tag))) return;
    onChange([...value, tag]);
  };
  return (
    <div className={m.field}>
      <label htmlFor={id}>タグ</label>
      <span className={m.tagInput}>
        {value.map((tag) => (
          <button
            type="button"
            key={tag}
            aria-label={`タグ「${tag}」を外す`}
            onClick={() => onChange(value.filter((t) => t !== tag))}
          >
            {tag} ×
          </button>
        ))}
        <input
          id={id}
          value={draft}
          placeholder={value.length >= MAX_WORK_TAGS ? "" : "タグを追加"}
          disabled={value.length >= MAX_WORK_TAGS}
          maxLength={MAX_WORK_TAG_LENGTH + 1}
          onChange={(e) => {
            const next = e.target.value;
            if (/[,、，]$/.test(next)) {
              add(next.slice(0, -1));
              setDraft("");
            } else setDraft(next);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add(draft);
              setDraft("");
            } else if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => {
            if (draft.trim()) {
              add(draft);
              setDraft("");
            }
          }}
        />
      </span>
      <small className={m.hint}>
        Enter で足します。{MAX_WORK_TAGS} 個まで、1 個 {MAX_WORK_TAG_LENGTH} 文字まで。
      </small>
    </div>
  );
}

export function ItemAction({ work, item }: { work: Work | null; item?: OwnedItem }) {
  const { busy, ownedLoaded, ownedError, retry } = useCatalog();
  const { session, status, me } = useApp();
  const reasonId = useId();
  const allowed = !!work && (work.perms.use || work.owner === me?.id);
  const world = work?.outputKind === "world";
  const unavailable = item ? !item.available : !work?.latest || !allowed;
  const reason = unavailable
    ? (item?.reason ?? (!work?.latest ? "バージョンがありません" : "利用する権限がありません"))
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
        onClick={() =>
          item && world
            ? openWorldPage(item.workId)
            : item
              ? void takeOut(item)
              : work && void acquire(work)
        }
      >
        {busy === work?.id
          ? "処理しています…"
          : item && world
            ? "ワールドを見る"
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

/** ワールドのページを開き、そのワールドを選ぶ */
export function openWorldPage(workId: string) {
  const menu = useMainMenu.getState();
  menu.setQuery("worlds", "");
  menu.select("worlds", workId);
  menu.selectPage("worlds");
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
  const item = retry ? (owned.find((i) => i.workId === retry.workId) ?? retry.item) : undefined;
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
