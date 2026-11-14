import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../app/store";
import { Thumbnail } from "../app/Thumbnail";
import { api, type Release, type Work } from "../net/api";
import { currentWorld } from "../session/openWorld";
import { priceLabel, WorkArt } from "./CatalogPage";
import { refreshOwned, useCatalog } from "./catalogStore";
import styles from "./MainMenu.module.css";
import m from "./Market.module.css";
import { enterSession } from "./sessionActions";
import { useMainMenu } from "./store";

/** マーケットにあるワールドから、セッションのルートワールドを選ぶ（ADR 0066） */
export function WorldsPage() {
  const client = useApp((s) => s.client);
  const session = useApp((s) => s.session);
  const me = useApp((s) => s.me);
  const status = useApp((s) => s.status);
  const myName = useApp((s) => s.myName);
  const { queries, selected, pendingSession, sessionError } = useMainMenu();
  const navigate = useNavigate();
  const [works, setWorks] = useState<Work[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const waiting = useRef(false);
  /** マーケットにあるワールドの一覧か、自分のワールド（登録していない非公開のものも含む）の一覧か */
  const [view, setView] = useState<"market" | "mine">("market");

  const owned = useCatalog((c) => c.owned);
  const ownedReady = useCatalog((c) => c.ownedLoaded || c.ownedError !== null);
  const loadSeq = useRef(0);
  const reload = useCallback(() => {
    const seq = ++loadSeq.current;
    setLoadError(null);
    (view === "mine" ? myWorlds() : marketWorlds()).then(
      (list) => {
        if (seq !== loadSeq.current) return;
        setWorks(list);
        setLoaded(true);
      },
      (e: Error) => {
        if (seq !== loadSeq.current) return;
        setLoadError(e.message);
        setLoaded(true);
      },
    );
  }, [view]);
  useEffect(() => reload(), [reload]);
  // 所持一覧が読めるまで鍵の状態が決まらない。つながっていないときは、待たずに出す
  const ready = loaded && (ownedReady || status !== "online");
  useEffect(
    () =>
      client.on((msg) => {
        if (!waiting.current) return;
        if (msg.t === "error") {
          waiting.current = false;
          setActionError(msg.message);
        } else if (msg.t === "session") {
          waiting.current = false;
        }
      }),
    [client],
  );

  // マーケットで有料なら、作者か入手した人だけが開ける（無料はだれでも）
  const ownedIds = new Set(owned.map((item) => item.workId));
  const worlds = works.map((w) => ({
    ...w,
    unlocked: !w.market?.price || w.owner === me?.id || ownedIds.has(w.id),
  }));
  const query = queries.worlds.trim().toLocaleLowerCase();
  const list = worlds.filter((w) =>
    `${w.name} ${w.ownerName ?? ""} ${w.repoName ?? ""}`.toLocaleLowerCase().includes(query),
  );
  const chosen = list.find((w) => w.id === selected.worlds) ?? list[0];
  // マーケットから選ばれたワールドが自分のワールドに無ければ、マーケットの一覧へ戻す
  useEffect(() => {
    if (
      view === "mine" &&
      loaded &&
      selected.worlds &&
      !works.some((w) => w.id === selected.worlds)
    )
      setView("market");
  }, [view, loaded, selected.worlds, works]);
  const open = currentWorld(session?.placements ?? []);
  useEffect(() => {
    if (!nameEdited) setName((chosen?.name ?? `${myName} のワールド`).slice(0, 64));
  }, [chosen?.name, myName, nameEdited]);

  const shownError = session ? actionError : (actionError ?? sessionError);
  // 自分のワールドは最新のリリースを、マーケットのワールドは公開中の版を開く
  const releaseOf = (w: Work) => (view === "mine" ? w.latest : w.market?.release) ?? null;
  const choose = (next: "market" | "mine") => {
    if (next === view) return;
    setView(next);
    setLoaded(false);
    setWorks([]);
  };
  const changeWorld = (releaseId: string) => {
    setActionError(null);
    waiting.current = true;
    client.send({ t: "session.openWorld", releaseId });
  };

  return (
    <>
      {view === "mine" && (
        <button type="button" className={styles.backLink} onClick={() => choose("market")}>
          ← マーケットのワールドへ戻る
        </button>
      )}
      <div className={styles.pageHeader}>
        <div>
          <h1>{view === "mine" ? "自分のワールド" : "ワールド"}</h1>
          <p className={styles.muted}>
            {view === "mine"
              ? "自分が作ったワールドです。マーケットに出していない非公開のワールドは、ここだけに出て、自分だけが開けます。"
              : "マーケットにあるワールドです。無料のものと購入したものを開けます。有料のワールドは、マーケットで購入してから開けます。"}
            {session
              ? " 変える前に、セッションの全員へ3秒のカウントダウンが出ます。"
              : " 選んだワールドで、新しいセッションを開けます。"}
          </p>
        </div>
        {view === "market" && (
          <div className={styles.headerActions}>
            <button className={styles.button} type="button" onClick={() => choose("mine")}>
              自分のワールド
            </button>
            <button className={styles.button} type="button" onClick={() => openMarket()}>
              マーケットで探す
            </button>
          </div>
        )}
      </div>
      {session && (
        <p className={styles.notice} role="status">
          {session.worldChange
            ? `${session.worldChange.byName} が、ワールドを「${session.worldChange.worldName}」に変えるところです。`
            : `いまのワールド：${open?.outputName ?? "まだ開いていません"}`}
        </p>
      )}
      <div className={styles.toolbar}>
        <input
          aria-label="ワールドを検索"
          placeholder="ワールド名・作者で検索"
          value={queries.worlds}
          onChange={(e) => useMainMenu.getState().setQuery("worlds", e.target.value)}
        />
        <button
          className={styles.button}
          type="button"
          onClick={() => {
            reload();
            void refreshOwned();
          }}
        >
          更新
        </button>
      </div>
      {loadError && (
        <p role="alert" className={styles.error}>
          {loadError}
        </p>
      )}
      {status !== "online" && (
        <p role="status" className={styles.notice}>
          接続を確認しています。表示内容は最後に受け取ったものです。
        </p>
      )}
      {shownError && (
        <p role="alert" className={styles.error}>
          {shownError}
        </p>
      )}
      {!ready ? (
        <p role="status">ワールドを読み込んでいます…</p>
      ) : (
        <div className={styles.split}>
          <div className={styles.list}>
            {list.length === 0 && (
              <p className={styles.empty}>
                {query
                  ? "検索に一致するワールドはありません。"
                  : view === "mine"
                    ? "リリースした自分のワールドはまだありません。プロジェクトでワールドをリリースすると、ここに出ます。"
                    : "マーケットにワールドはまだありません。"}
              </p>
            )}
            <div className={m.grid}>
              {list.map((w) => {
                const release = releaseOf(w);
                const opened = !!release && open?.releaseId === release.id;
                const pending = !!release && session?.worldChange?.releaseId === release.id;
                const price = w.market?.price ?? 0;
                return (
                  <button
                    type="button"
                    key={w.id}
                    className={m.card}
                    aria-pressed={chosen?.id === w.id}
                    aria-label={w.name}
                    onClick={() => useMainMenu.getState().select("worlds", w.id)}
                  >
                    <span className={m.cardArt} data-kind="world">
                      <WorkArt work={w} size={40} />
                      <span className={m.kindTag}>
                        {opened
                          ? "開いています"
                          : pending
                            ? "まもなく変わります"
                            : view === "mine" && !w.market
                              ? "非公開"
                              : "ワールド"}
                      </span>
                      {view === "market" && w.unlocked && price > 0 && w.owner !== me?.id && (
                        <span className={m.ownedTag}>✓ 入手済み</span>
                      )}
                    </span>
                    <span className={m.cardCopy}>
                      <b>{w.name}</b>
                      <span className={m.author}>
                        {w.ownerName ?? "作者"}
                        {release ? ` · v${release.version}` : ""}
                      </span>
                      <span
                        className={m.price}
                        data-free={(!!w.market && price === 0) || undefined}
                      >
                        {!w.unlocked && <LockIcon />}{" "}
                        {w.market
                          ? view === "mine"
                            ? `マーケット · ${priceLabel(price)}`
                            : priceLabel(price)
                          : "自分だけ"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {chosen && (
            <WorldDetail
              work={chosen}
              release={releaseOf(chosen)}
              mine={view === "mine"}
              inSession={!!session}
              opened={
                releaseOf(chosen)?.id !== undefined && open?.releaseId === releaseOf(chosen)?.id
              }
              changing={session?.worldChange?.releaseId === releaseOf(chosen)?.id}
              canUse={chosen.perms.use || chosen.owner === me?.id}
              locked={!chosen.unlocked}
              name={name}
              onName={(value) => {
                setNameEdited(true);
                setName(value);
              }}
              offline={status !== "online"}
              pending={pendingSession}
              onChange={() => {
                const releaseId = releaseOf(chosen)?.id;
                if (releaseId) changeWorld(releaseId);
              }}
              onCreate={() => {
                const releaseId = releaseOf(chosen)?.id;
                if (!releaseId || !name.trim()) return;
                void enterSession(
                  { t: "session.create", name: name.trim(), worldReleaseId: releaseId },
                  navigate,
                );
              }}
            />
          )}
        </div>
      )}
    </>
  );
}

function WorldDetail({
  work,
  release,
  mine,
  inSession,
  opened,
  changing,
  canUse,
  locked,
  name,
  onName,
  offline,
  pending,
  onChange,
  onCreate,
}: {
  work: Work;
  /** 開く版。自分のワールドは最新のリリース、マーケットのワールドは公開中の版 */
  release: Release | null;
  /** 自分のワールドの一覧から選んだ */
  mine: boolean;
  inSession: boolean;
  opened: boolean;
  changing: boolean;
  canUse: boolean;
  /** マーケットで有料で、まだ入手していない */
  locked: boolean;
  name: string;
  onName(value: string): void;
  offline: boolean;
  pending: boolean;
  onChange(): void;
  onCreate(): void;
}) {
  const releaseId = release?.id;
  return (
    <aside className={styles.detail} aria-label="ワールドの詳細">
      {work.thumbnail && (
        <div className={`${styles.itemArt} ${styles.itemArtImage}`}>
          <Thumbnail id={work.thumbnail} name={work.name} />
        </div>
      )}
      <span className={styles.eyebrow}>
        {mine && !work.market ? "非公開のワールド" : "ワールド"}
      </span>
      <h2>{work.name}</h2>
      <p className={styles.muted}>
        {work.ownerName ?? "作者"} / {work.repoName}
        {release ? ` · v${release.version}` : ""}
      </p>
      {!canUse && <p className={styles.muted}>利用の権限がありません。</p>}
      {canUse && locked ? (
        <>
          <p className={styles.notice}>
            <LockIcon /> 有料のワールドです（{priceLabel(work.market?.price ?? 0)}
            ）。マーケットで購入すると開けます。
          </p>
          <button type="button" className={styles.primary} onClick={() => openMarket(work.id)}>
            マーケットで購入する
          </button>
        </>
      ) : inSession ? (
        opened ? (
          <p>このワールドを開いています。</p>
        ) : (
          <button
            type="button"
            className={styles.primary}
            disabled={!releaseId || !canUse || offline || pending || changing}
            title={canUse ? "3秒後に、セッションの全員のワールドが変わります" : undefined}
            onClick={onChange}
          >
            {changing ? "まもなく変わります" : "このワールドに変える"}
          </button>
        )
      ) : (
        <form
          className={styles.field}
          onSubmit={(e) => {
            e.preventDefault();
            onCreate();
          }}
        >
          <label>
            セッションの名前
            <input value={name} onChange={(e) => onName(e.target.value)} maxLength={64} required />
          </label>
          <button
            className={styles.primary}
            type="submit"
            disabled={!releaseId || !canUse || offline || pending || !name.trim()}
            title={canUse ? "このワールドで、新しいセッションを開きます" : undefined}
          >
            {pending ? "開いています…" : "このワールドでセッションを開く"}
          </button>
        </form>
      )}
    </aside>
  );
}

/** マーケットに登録されたワールドを、すべて読む（一覧は数十件ずつ返る） */
async function marketWorlds(): Promise<Work[]> {
  const all: Work[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await api.market("", offset, undefined, [], "world");
    all.push(...page.items);
    offset = page.nextOffset;
  }
  return all;
}

/** 自分がリリースしたワールドを、マーケットに出しているかに関わらず、すべて読む */
async function myWorlds(): Promise<Work[]> {
  const mine = await api.myMarket();
  return [...mine.listed, ...mine.unlisted].filter((w) => w.outputKind === "world" && w.latest);
}

/** マーケットを、ワールドだけの表示で開く。workId を渡すと、その作品を選ぶ */
function openMarket(workId?: string) {
  const menu = useMainMenu.getState();
  useCatalog.setState({ marketKind: "world", marketTags: [] });
  menu.setQuery("market", "");
  menu.select("market", workId);
  menu.selectPage("market");
}

function LockIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      role="img"
      aria-label="鍵"
      style={{ verticalAlign: "-2px" }}
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
