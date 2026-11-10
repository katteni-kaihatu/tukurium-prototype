import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../app/store";
import { CatalogNotice, ItemAction, ItemArt } from "./CatalogPage";
import { refreshRecent, useCatalog } from "./catalogStore";
import { Invitations } from "./Invitations";
import styles from "./MainMenu.module.css";
import { useMenuPageNavigation } from "./MenuShortcuts";
import { enterSession } from "./sessionActions";
import { AVAILABILITY, refreshSocial, useSocial } from "./socialStore";
import { useMainMenu } from "./store";

export function HomeHub({ active }: { active: boolean }) {
  const { myName, setName, session, status, closedReason } = useApp();
  const menu = useMainMenu();
  const catalog = useCatalog();
  const social = useSocial();
  const navigate = useNavigate();
  const go = useMenuPageNavigation();
  const [name, setDraftName] = useState(myName);
  const [roomName, setRoomName] = useState(`${myName} の作業部屋`);
  useEffect(() => setDraftName(myName), [myName]);
  useEffect(() => {
    if (active && menu.open && status === "online" && catalog.owner) void refreshRecent();
  }, [active, menu.open, status, catalog.owner]);
  const friends = social.data?.friends ?? [];
  // フレンドがいるセッションを、フレンドが多い順に
  const rooms = [
    ...new Map(friends.flatMap((f) => f.presence.sessions).map((s) => [s.id, s])).values(),
  ]
    .map((room) => ({
      ...room,
      friends: friends.filter((f) => f.presence.sessions.some((s) => s.id === room.id)).length,
    }))
    .sort((a, b) => b.friends - a.friends);
  // 参加できるセッションにいないフレンド
  const online = friends.filter((f) => f.presence.online && f.presence.sessions.length === 0);
  const showSession = (id: string) => {
    menu.setQuery("sessions", "");
    menu.select("sessions", id);
    menu.selectPage("sessions");
  };
  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1>ホーム</h1>
          <p className={styles.muted}>{myName}さん、今日はどこで過ごしますか。</p>
        </div>
        <span className={styles.eyebrow}>
          {session ? "セッションに参加中" : "集まる場所を見つけよう"}
        </span>
      </div>
      {closedReason && (
        <p className={styles.notice} role="status">
          {closedReason}
        </p>
      )}
      {menu.sessionError && (
        <p className={styles.error} role="alert">
          {menu.sessionError}
        </p>
      )}
      <Invitations compact />
      <CatalogNotice />
      <div className={styles.homeColumns}>
        <div className={styles.homeMain}>
          <section aria-label="フレンドの今">
            <div className={styles.sectionHeader}>
              <h2>
                フレンドの今
                <span className={styles.sectionNote}>
                  フレンドがいるセッションを、フレンドが多い順に
                </span>
              </h2>
              <button type="button" onClick={() => menu.selectPage("friends")}>
                フレンドを見る
              </button>
            </div>
            {social.loading && !social.data ? (
              <p className={styles.muted}>フレンドのいる場所を読み込んでいます…</p>
            ) : !social.data ? null : rooms.length ? (
              <div className={styles.roomGrid}>
                {rooms.map((s) => (
                  <article className={styles.roomCard} key={s.id}>
                    <div className={styles.roomBand}>
                      <span className={styles.countChip}>{s.count} 人</span>
                      <span className={styles.spacer} />
                      {session?.id === s.id ? (
                        <span className={styles.hereChip}>参加中</span>
                      ) : (
                        <button
                          type="button"
                          className={styles.primary}
                          disabled={status !== "online" || menu.pendingSession}
                          onClick={() =>
                            void enterSession({ t: "session.join", sessionId: s.id }, navigate)
                          }
                        >
                          参加する
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      className={styles.roomBody}
                      onClick={() => showSession(s.id)}
                    >
                      <strong>{s.name}</strong>
                      <b className={styles.friendCount}>フレンド {s.friends} 人</b>
                      <span className={styles.caption}>
                        {s.participants.map((p) => p.name).join("・")}
                      </span>
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className={styles.empty}>
                <p>いまフレンドが参加しているセッションはありません。</p>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => menu.selectPage("sessions")}
                >
                  開いているセッションを見る
                </button>
              </div>
            )}
            {social.error && (
              <p className={styles.error} role="alert">
                {social.error}
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => void refreshSocial()}
                >
                  再読み込み
                </button>
              </p>
            )}
          </section>
          <section aria-label="オンラインのフレンド">
            <div className={styles.sectionHeader}>
              <h2>
                オンラインのフレンド
                <span className={styles.sectionNote}>参加できるセッションにいないフレンド</span>
              </h2>
            </div>
            {online.length ? (
              <div className={styles.friendGrid}>
                {online.map((f) => (
                  <div className={styles.friendRow} key={f.user.id}>
                    <span className={styles.avatar} data-status={f.profile.availability}>
                      {f.user.name.slice(0, 1)}
                    </span>
                    <span className={styles.friendText}>
                      <strong>{f.user.name}</strong>
                      <small data-status={f.profile.availability}>
                        {AVAILABILITY[f.profile.availability]}
                        {f.profile.note && ` · ${f.profile.note}`}
                      </small>
                    </span>
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => {
                        menu.select("friends", f.user.id);
                        menu.selectPage("friends");
                      }}
                    >
                      誘う
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={`${f.user.name} にメッセージ`}
                      title="メッセージ"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M4 5h16v11H9l-5 4z" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.muted}>
                いまオンラインで、セッションにいないフレンドはいません。
              </p>
            )}
          </section>
          <section aria-label="ホームの所持アイテム">
            <div className={styles.sectionHeader}>
              <h2>所持アイテム</h2>
              <button type="button" onClick={() => menu.selectPage("items")}>
                すべてのアイテム
              </button>
            </div>
            {!catalog.ownedLoaded && catalog.ownedLoading ? (
              <p className={styles.muted}>所持アイテムを読み込んでいます…</p>
            ) : !catalog.ownedLoaded ? null : catalog.owned.length ? (
              <div className={styles.homeItems}>
                {catalog.owned.slice(0, 4).map((item) => (
                  <article className={styles.itemCard} key={item.workId}>
                    <button
                      type="button"
                      className={styles.artButton}
                      aria-label={`${item.work?.name ?? "アイテム"} を所持一覧で見る`}
                      onClick={() => {
                        menu.select("items", item.workId);
                        menu.selectPage("items");
                      }}
                    >
                      <ItemArt work={item.work} />
                    </button>
                    <div className={styles.cardCopy}>
                      <strong>{item.work?.name ?? "利用できないアイテム"}</strong>
                      <ItemAction work={item.work} item={item} />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className={styles.empty}>
                <p>使ってみたいアイテムをマーケットで入手できます。</p>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => menu.selectPage("market")}
                >
                  マーケットを見る
                </button>
              </div>
            )}
          </section>
          <section aria-label="マーケットの新着">
            <div className={styles.sectionHeader}>
              <h2>マーケットの新着</h2>
              <button type="button" onClick={() => menu.selectPage("market")}>
                マーケットを見る
              </button>
            </div>
            {catalog.recentLoading ? (
              <p className={styles.muted}>新着を読み込んでいます…</p>
            ) : catalog.recentError ? null : catalog.recent.length ? (
              <div className={styles.homeItems}>
                {catalog.recent.map((work) => (
                  <button
                    type="button"
                    className={styles.recentCard}
                    key={work.id}
                    onClick={() => {
                      menu.setQuery("market", "");
                      menu.select("market", work.id);
                      menu.selectPage("market");
                    }}
                  >
                    <ItemArt work={work} />
                    <strong>{work.name}</strong>
                    <span className={styles.caption}>{work.ownerName}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className={styles.empty}>公開されたアイテムはまだありません。</p>
            )}
            {catalog.recentError && (
              <p className={styles.error}>
                {catalog.recentError}
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => void refreshRecent()}
                >
                  再読み込み
                </button>
              </p>
            )}
          </section>
        </div>
        <aside className={styles.homeAside} aria-label="ホームの操作">
          {session ? (
            <section className={styles.detail}>
              <span className={styles.eyebrow}>いまいる場所</span>
              <h2>{session.name}</h2>
              <p className={styles.muted}>{session.participants.length}人が参加中</p>
              <button type="button" className={styles.primary} onClick={() => menu.close("home")}>
                このセッションに戻る
              </button>
              <button type="button" className={styles.button} onClick={() => go("/workspaces")}>
                制作を始める
              </button>
            </section>
          ) : (
            <form
              className={styles.createRoom}
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) setName(name.trim());
                if (roomName.trim())
                  void enterSession({ t: "session.create", name: roomName.trim() }, navigate);
              }}
            >
              <h2>セッションを作る</h2>
              <label>
                あなたの名前
                <input
                  value={name}
                  maxLength={32}
                  required
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={() => {
                    if (name.trim() && name !== myName) setName(name.trim());
                  }}
                />
              </label>
              <label>
                セッションの名前
                <input
                  value={roomName}
                  maxLength={64}
                  required
                  onChange={(e) => setRoomName(e.target.value)}
                />
              </label>
              <button
                type="submit"
                className={styles.primary}
                disabled={status !== "online" || menu.pendingSession}
              >
                セッションを作って入る
              </button>
            </form>
          )}
          <section className={styles.detail}>
            <h2>制作する</h2>
            <button type="button" className={styles.button} onClick={() => go("/new")}>
              新しいプロジェクト
            </button>
            <button type="button" className={styles.button} onClick={() => go("/u/me")}>
              自分のプロジェクト
            </button>
          </section>
        </aside>
      </div>
    </>
  );
}
