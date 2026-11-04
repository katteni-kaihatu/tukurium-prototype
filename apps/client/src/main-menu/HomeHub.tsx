import { emptyProject } from "@tukurium/repo-model";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../app/store";
import { useWorkspace } from "../workspace/store";
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
  const rooms = [
    ...new Map(
      (social.data?.friends ?? []).flatMap((f) => f.presence.sessions).map((s) => [s.id, s]),
    ).values(),
  ];
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
          <section aria-label="フレンドがいるセッション">
            <div className={styles.sectionHeader}>
              <h2>フレンドがいるセッション</h2>
              <button type="button" onClick={() => menu.selectPage("friends")}>
                フレンドを見る
              </button>
            </div>
            {social.loading && !social.data ? (
              <p className={styles.muted}>フレンドのいる場所を読み込んでいます…</p>
            ) : !social.data ? null : rooms.length ? (
              <div className={styles.roomGrid}>
                {rooms.map((s) => (
                  <button
                    type="button"
                    className={styles.listCard}
                    key={s.id}
                    onClick={() => showSession(s.id)}
                  >
                    <span className={styles.eyebrow}>{s.count}人が参加中</span>
                    <strong>{s.name}</strong>
                    <span className={styles.caption}>
                      {s.participants.map((p) => p.name).join("・")}
                    </span>
                  </button>
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
                      <ItemArt />
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
                    <ItemArt />
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
              <button type="button" className={styles.primary} onClick={() => menu.close()}>
                このセッションに戻る
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  useWorkspace
                    .getState()
                    .create("新しいワークスペース", emptyProject("新しいワークスペース"));
                  menu.close();
                }}
              >
                空のワークスペースを作る
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
          <section>
            <h2>オンラインのフレンド</h2>
            {(social.data?.friends ?? [])
              .filter((f) => f.presence.online)
              .map((f) => (
                <button
                  type="button"
                  className={styles.onlineFriend}
                  key={f.user.id}
                  onClick={() => {
                    menu.select("friends", f.user.id);
                    menu.selectPage("friends");
                  }}
                >
                  <span className={styles.avatar}>{f.user.name.slice(0, 1)}</span>
                  <span>
                    <strong>{f.user.name}</strong>
                    <small>{AVAILABILITY[f.profile.availability]}</small>
                  </span>
                </button>
              ))}
            {!social.data?.friends.some((f) => f.presence.online) && (
              <p className={styles.muted}>いまオンラインのフレンドはいません。</p>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
