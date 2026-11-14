import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../app/store";
import { Thumbnail } from "../app/Thumbnail";
import { api, type Work } from "../net/api";
import { currentWorld } from "../session/openWorld";
import { refreshOwned, useCatalog } from "./catalogStore";
import styles from "./MainMenu.module.css";
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

  const owned = useCatalog((c) => c.owned);
  const ownedReady = useCatalog((c) => c.ownedLoaded || c.ownedError !== null);
  const loadSeq = useRef(0);
  const reload = useCallback(() => {
    const seq = ++loadSeq.current;
    setLoadError(null);
    marketWorlds().then(
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
  }, []);
  useEffect(() => reload(), [reload]);
  const ready = loaded && ownedReady;
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
  const open = currentWorld(session?.placements ?? []);
  useEffect(() => {
    if (!nameEdited) setName((chosen?.name ?? `${myName} のワールド`).slice(0, 64));
  }, [chosen?.name, myName, nameEdited]);

  const shownError = session ? actionError : (actionError ?? sessionError);
  const marketRelease = (w: Work) => w.market?.release ?? null;
  const changeWorld = (releaseId: string) => {
    setActionError(null);
    waiting.current = true;
    client.send({ t: "session.openWorld", releaseId });
  };

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1>ワールド</h1>
          <p className={styles.muted}>
            {session
              ? "マーケットにあるワールドから、このセッションの場所を選べます。変える前に、全員へ3秒のカウントダウンが出ます。"
              : "マーケットにあるワールドを選ぶと、そのワールドで新しいセッションを開けます。有料のワールドは、購入してから開けます。"}
          </p>
        </div>
        <button className={styles.button} type="button" onClick={() => openMarket()}>
          マーケットで探す
        </button>
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
                  : "マーケットにワールドはまだありません。"}
              </p>
            )}
            {list.map((w) => {
              const releaseId = marketRelease(w)?.id;
              const opened = releaseId !== undefined && open?.releaseId === releaseId;
              const pending = session?.worldChange?.releaseId === releaseId;
              return (
                <button
                  type="button"
                  key={w.id}
                  className={styles.listCard}
                  aria-pressed={chosen?.id === w.id}
                  onClick={() => useMainMenu.getState().select("worlds", w.id)}
                >
                  <span className={styles.cardLead}>
                    {w.thumbnail && <Thumbnail id={w.thumbnail} name={w.name} size="small" />}
                    <span>
                      <span className={styles.eyebrow}>
                        {opened
                          ? "開いています"
                          : pending
                            ? "まもなく変わります"
                            : w.market?.price
                              ? w.unlocked
                                ? `入手済み · ${w.market.price.toLocaleString("ja-JP")} P`
                                : `有料 · ${w.market.price.toLocaleString("ja-JP")} P`
                              : "無料"}
                      </span>
                      <strong>
                        {!w.unlocked && <LockIcon />} {w.name}
                      </strong>
                    </span>
                  </span>
                  <span className={styles.muted}>
                    {w.ownerName ?? "作者"}
                    {w.market?.release ? ` · v${w.market.release.version}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
          {chosen && (
            <WorldDetail
              work={chosen}
              inSession={!!session}
              opened={
                marketRelease(chosen)?.id !== undefined &&
                open?.releaseId === marketRelease(chosen)?.id
              }
              changing={session?.worldChange?.releaseId === marketRelease(chosen)?.id}
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
                const releaseId = marketRelease(chosen)?.id;
                if (releaseId) changeWorld(releaseId);
              }}
              onCreate={() => {
                const releaseId = marketRelease(chosen)?.id;
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
  const release = work.market?.release ?? null;
  const releaseId = release?.id;
  return (
    <aside className={styles.detail} aria-label="ワールドの詳細">
      {work.thumbnail && (
        <div className={`${styles.itemArt} ${styles.itemArtImage}`}>
          <Thumbnail id={work.thumbnail} name={work.name} />
        </div>
      )}
      <span className={styles.eyebrow}>ワールド</span>
      <h2>{work.name}</h2>
      <p className={styles.muted}>
        {work.ownerName ?? "作者"} / {work.repoName}
        {release ? ` · v${release.version}` : ""}
      </p>
      {!canUse && <p className={styles.muted}>利用の権限がありません。</p>}
      {canUse && locked ? (
        <>
          <p className={styles.notice}>
            <LockIcon /> 有料のワールドです（{work.market?.price.toLocaleString("ja-JP")}{" "}
            P）。マーケットで購入すると開けます。
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
