import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../app/store";
import { Thumbnail } from "../app/Thumbnail";
import { api, type Work } from "../net/api";
import { currentWorld } from "../session/openWorld";
import { useCatalog } from "./catalogStore";
import styles from "./MainMenu.module.css";
import { enterSession } from "./sessionActions";
import { useMainMenu } from "./store";

/** 公開されているワールドから、セッションのルートワールドを選ぶ（ADR 0066） */
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

  const reload = () => {
    setLoadError(null);
    api.works().then(
      (list) => {
        setWorks(list);
        setLoaded(true);
      },
      (e: Error) => {
        setLoadError(e.message);
        setLoaded(true);
      },
    );
  };
  // マーケットで入手したら、鍵の状態を読み直す
  const ownedCount = useCatalog((c) => c.owned.length);
  useEffect(() => {
    void ownedCount;
    api.works().then(
      (list) => {
        setWorks(list);
        setLoaded(true);
      },
      (e: Error) => {
        setLoadError(e.message);
        setLoaded(true);
      },
    );
  }, [ownedCount]);
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

  const worlds = works.filter((w) => w.outputKind === "world" && w.latest);
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
              ? "公開されているワールドから、このセッションの場所を選べます。変える前に、全員へ3秒のカウントダウンが出ます。"
              : "公開されているワールドを選ぶと、そのワールドで新しいセッションを開けます。"}
          </p>
        </div>
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
        <button className={styles.button} type="button" onClick={reload}>
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
      {!loaded ? (
        <p role="status">ワールドを読み込んでいます…</p>
      ) : (
        <div className={styles.split}>
          <div className={styles.list}>
            {list.length === 0 && (
              <p className={styles.empty}>
                {query
                  ? "検索に一致するワールドはありません。"
                  : "公開されたワールドはまだありません。"}
              </p>
            )}
            {list.map((w) => {
              const releaseId = w.latest?.id;
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
                            : w.unlocked === false
                              ? `有料 · ${w.price?.toLocaleString("ja-JP")} P`
                              : "ワールド"}
                      </span>
                      <strong>
                        {w.unlocked === false && <LockIcon />} {w.name}
                      </strong>
                    </span>
                  </span>
                  <span className={styles.muted}>
                    {w.ownerName ?? "作者"}
                    {w.latest ? ` · v${w.latest.version}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
          {chosen && (
            <WorldDetail
              work={chosen}
              inSession={!!session}
              opened={chosen.latest?.id !== undefined && open?.releaseId === chosen.latest.id}
              changing={session?.worldChange?.releaseId === chosen.latest?.id}
              canUse={chosen.perms.use || chosen.owner === me?.id}
              locked={chosen.unlocked === false}
              name={name}
              onName={(value) => {
                setNameEdited(true);
                setName(value);
              }}
              offline={status !== "online"}
              pending={pendingSession}
              onChange={() => {
                const releaseId = chosen.latest?.id;
                if (releaseId) changeWorld(releaseId);
              }}
              onCreate={() => {
                const releaseId = chosen.latest?.id;
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
  const releaseId = work.latest?.id;
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
        {work.latest ? ` · v${work.latest.version}` : ""}
      </p>
      {!canUse && <p className={styles.muted}>利用の権限がありません。</p>}
      {canUse && locked ? (
        <>
          <p className={styles.notice}>
            <LockIcon /> 有料のワールドです（{work.price?.toLocaleString("ja-JP")}{" "}
            P）。マーケットで入手すると開けます。
          </p>
          <button
            type="button"
            className={styles.primary}
            onClick={() => {
              const menu = useMainMenu.getState();
              menu.setQuery("market", "");
              menu.select("market", work.id);
              menu.selectPage("market");
            }}
          >
            マーケットで入手する
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
