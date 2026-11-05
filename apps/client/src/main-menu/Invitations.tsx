import { useEffect } from "react";
import { useApp } from "../app/store";
import { api, type InvitationView } from "../net/api";
import styles from "./MainMenu.module.css";
import { changeSocial, refreshSocial, useSocial } from "./socialStore";
import { useMainMenu } from "./store";

const LABELS = {
  pending: "返事待ち",
  accepted: "承認済み",
  declined: "辞退済み",
  cancelled: "取り消し済み",
  expired: "期限切れ",
};
export function Invitations({ compact = false }: { compact?: boolean }) {
  const { data, busy } = useSocial();
  const status = useApp((s) => s.status);
  const open = useMainMenu((s) => s.open);
  const incoming = data?.invitations.incoming ?? [];
  const outgoing = data?.invitations.outgoing ?? [];
  const pending = [...incoming, ...outgoing].filter((i) => i.status === "pending");
  const expires = pending.map((i) => Date.parse(i.expiresAt)).sort((a, b) => a - b)[0];
  useEffect(() => {
    if (!open || expires === undefined) return;
    const timer = setTimeout(
      () => void refreshSocial(),
      Math.max(1000, expires - Date.now() + 100),
    );
    return () => clearTimeout(timer);
  }, [expires, open]);
  const show = (invite: InvitationView) => {
    if (!invite.session) return;
    const menu = useMainMenu.getState();
    menu.setQuery("sessions", "");
    menu.select("sessions", invite.session.id);
    menu.selectPage("sessions");
  };
  const accept = async (invite: InvitationView) => {
    if (await changeSocial(() => api.respondInvite(invite.id, "accept"))) show(invite);
  };
  const render = (invite: InvitationView, received: boolean) => (
    <article className={styles.invitation} key={invite.id}>
      <div>
        <span className={styles.eyebrow}>
          {received
            ? `${invite.from?.name ?? "相手"}から招待`
            : `${invite.to?.name ?? "相手"}へ招待`}
        </span>
        <strong>{invite.session?.name ?? "終了したセッション"}</strong>
        <span className={styles.caption}>
          {LABELS[invite.status]} ·{" "}
          {new Date(invite.expiresAt).toLocaleTimeString("ja-JP", {
            hour: "2-digit",
            minute: "2-digit",
          })}
          まで
        </span>
      </div>
      <div className={styles.inlineActions}>
        {received && invite.status === "pending" ? (
          <>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || status !== "online"}
              onClick={() => void accept(invite)}
            >
              受け取って参加先を見る
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={busy || status !== "online"}
              onClick={() => void changeSocial(() => api.respondInvite(invite.id, "decline"))}
            >
              辞退する
            </button>
          </>
        ) : !received && invite.status === "pending" ? (
          <button
            type="button"
            className={styles.button}
            disabled={busy || status !== "online"}
            onClick={() => void changeSocial(() => api.respondInvite(invite.id, "cancel"))}
          >
            招待を取り消す
          </button>
        ) : received && invite.status === "accepted" && invite.session ? (
          <button type="button" className={styles.button} onClick={() => show(invite)}>
            参加先を見る
          </button>
        ) : null}
      </div>
    </article>
  );
  const currentIncoming = incoming.filter((i) => i.status === "pending");
  const currentOutgoing = outgoing.filter((i) => i.status === "pending");
  if (compact && !currentIncoming.length) return null;
  const history = [
    ...incoming.map((i) => ({ i, received: true })),
    ...outgoing.map((i) => ({ i, received: false })),
  ]
    .filter(({ i }) => i.status !== "pending")
    .sort((a, b) => b.i.createdAt.localeCompare(a.i.createdAt))
    .slice(0, 5);
  if (!currentIncoming.length && !currentOutgoing.length && !history.length) return null;
  return (
    <section className={styles.requests} aria-label="セッションの招待">
      <h2>セッションの招待</h2>
      {currentIncoming.map((i) => render(i, true))}
      {!compact && currentOutgoing.map((i) => render(i, false))}
      {!compact && !!history.length && (
        <details>
          <summary>以前の招待</summary>
          {history.map(({ i, received }) => render(i, received))}
        </details>
      )}
    </section>
  );
}
