import { randomUUID } from "node:crypto";
import { isOfficial } from "@tukurium/repo-model";
import { SocialProfile } from "@tukurium/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Hub } from "../hub";
import { HttpError } from "../repos/service";
import type { SessionInvitation, Store, User } from "../store/store";

export function registerSocialRoutes(app: FastifyInstance, store: Store, hub: Hub) {
  const userOf = async (req: FastifyRequest) => {
    const token = req.headers["x-tukurium-token"];
    const user = typeof token === "string" ? await store.userByToken(token) : null;
    if (!user) throw new HttpError(401, "本人確認ができません（接続し直してください）");
    return user;
  };
  const handle =
    <P>(run: (req: FastifyRequest<{ Params: P }>, user: User) => Promise<unknown>) =>
    async (req: FastifyRequest<{ Params: P }>, reply: FastifyReply) => {
      try {
        return await run(req, await userOf(req));
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
        if (e instanceof z.ZodError)
          return reply.code(400).send({ error: "入力が正しくありません" });
        throw e;
      }
    };
  const otherUser = async (user: User, id: string) => {
    if (user.id === id) throw new HttpError(400, "自分にはフレンド申請できません");
    const other = await store.user(id);
    if (!other || isOfficial(other.id)) throw new HttpError(404, "相手が見つかりません");
    return other;
  };
  const areFriends = async (a: string, b: string) =>
    (await store.friendships(a)).some(
      (f) => f.status === "accepted" && (f.from === b || f.to === b),
    );
  const viewInvitation = async (invite: SessionInvitation) => {
    const session = hub.sessionSummary(invite.sessionId);
    let status: SessionInvitation["status"] | "expired" = invite.status;
    if (status === "pending") {
      if (!(await areFriends(invite.from, invite.to))) status = "cancelled";
      else if (Date.parse(invite.expiresAt) <= Date.now() || !session) status = "expired";
    }
    return {
      id: invite.id,
      from: await store.user(invite.from),
      to: await store.user(invite.to),
      session,
      status,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    };
  };

  app.get(
    "/api/me/social",
    handle(async (_req, user) => {
      const links = await store.friendships(user.id);
      const friends = [];
      const incoming = [];
      const outgoing = [];
      for (const link of links) {
        const other = await store.user(link.from === user.id ? link.to : link.from);
        if (!other) continue;
        if (link.status === "accepted")
          friends.push({
            user: other,
            profile: await store.socialProfile(other.id),
            presence: hub.presence(other.id),
          });
        else if (link.to === user.id) incoming.push({ user: other, createdAt: link.createdAt });
        else outgoing.push({ user: other, createdAt: link.createdAt });
      }
      const invitations = await store.invitations(user.id);
      return {
        profile: await store.socialProfile(user.id),
        friends,
        incoming,
        outgoing,
        invitations: {
          incoming: await Promise.all(
            invitations.filter((i) => i.to === user.id).map(viewInvitation),
          ),
          outgoing: await Promise.all(
            invitations.filter((i) => i.from === user.id).map(viewInvitation),
          ),
        },
      };
    }),
  );
  app.patch(
    "/api/me/social",
    handle(async (req, user) => {
      const profile = SocialProfile.parse(req.body);
      await store.saveSocialProfile(user.id, profile);
      hub.notifySocial(user.id);
      return profile;
    }),
  );
  app.get(
    "/api/people",
    handle(async (req, user) => {
      const { q } = z.object({ q: z.string().trim().min(1).max(80) }).parse(req.query);
      const links = await store.friendships(user.id);
      return (await store.searchUsers(q, 21))
        .filter((u) => u.id !== user.id && !isOfficial(u.id))
        .slice(0, 20)
        .map((other) => {
          const link = links.find((f) => f.from === other.id || f.to === other.id);
          const relation =
            link?.status === "accepted"
              ? "friend"
              : link
                ? link.from === user.id
                  ? "outgoing"
                  : "incoming"
                : "none";
          return { user: other, relation };
        });
    }),
  );
  app.post(
    "/api/me/friends/:userId/request",
    handle<{ userId: string }>(async (req, user) => {
      const other = await otherUser(user, req.params.userId);
      if (
        (await store.friendships(user.id)).filter(
          (f) => f.from === user.id && f.status === "pending",
        ).length >= 50
      )
        throw new HttpError(409, "送信中の申請が多すぎます。不要な申請を取り消してください");
      const link = await store.requestFriendship({
        from: user.id,
        to: other.id,
        status: "pending",
        createdAt: new Date().toISOString(),
      });
      if (link.status === "pending" && link.to === user.id)
        throw new HttpError(409, "相手から申請が届いています。受信した申請から承認してください");
      hub.notifyUsers([user.id, other.id]);
      return link;
    }),
  );
  app.post(
    "/api/me/friends/:userId/accept",
    handle<{ userId: string }>(async (req, user) => {
      const other = await otherUser(user, req.params.userId);
      const link = await store.acceptFriendship(user.id, other.id);
      if (!link) throw new HttpError(409, "承認する申請がありません");
      hub.notifyUsers([user.id, other.id]);
      return link;
    }),
  );
  app.delete(
    "/api/me/friends/:userId",
    handle<{ userId: string }>(async (req, user) => {
      const other = await otherUser(user, req.params.userId);
      await store.removeFriendship(user.id, other.id);
      for (const invite of await store.invitations(user.id))
        if (invite.status === "pending" && (invite.from === other.id || invite.to === other.id))
          await store.respondInvitation(
            invite.id,
            user.id,
            invite.from === user.id ? "cancelled" : "declined",
          );
      hub.notifyUsers([user.id, other.id]);
      return { ok: true };
    }),
  );
  app.post(
    "/api/me/invitations",
    handle(async (req, user) => {
      const { to, sessionId } = z
        .object({ to: z.string().min(1).max(64), sessionId: z.string().min(1).max(64) })
        .parse(req.body);
      await otherUser(user, to);
      if (!(await areFriends(user.id, to))) throw new HttpError(403, "招待できるのはフレンドです");
      if (!hub.presence(user.id).sessions.some((s) => s.id === sessionId))
        throw new HttpError(403, "参加中のセッションから招待してください");
      const previous = await store.invitations(user.id);
      if (
        previous.filter(
          (i) =>
            i.from === user.id && i.status === "pending" && Date.parse(i.expiresAt) > Date.now(),
        ).length >= 50
      )
        throw new HttpError(409, "送信中の招待が多すぎます。不要な招待を取り消してください");
      const invite = await store.createInvitation({
        id: randomUUID(),
        from: user.id,
        to,
        sessionId,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      hub.notifyUsers([user.id, to]);
      return viewInvitation(invite);
    }),
  );
  app.post(
    "/api/me/invitations/:id/respond",
    handle<{ id: string }>(async (req, user) => {
      const { action } = z
        .object({ action: z.enum(["accept", "decline", "cancel"]) })
        .parse(req.body);
      const invite = await store.invitation(req.params.id);
      if (!invite) throw new HttpError(404, "招待が見つかりません");
      if (action === "cancel" ? invite.from !== user.id : invite.to !== user.id)
        throw new HttpError(403, "この招待には応答できません");
      const status =
        action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled";
      if (invite.status === status) return viewInvitation(invite);
      const current = await viewInvitation(invite);
      if (current.status !== "pending")
        throw new HttpError(409, "この招待は終了しました。セッションを選び直してください");
      const updated = await store.respondInvitation(invite.id, user.id, status);
      if (!updated) throw new HttpError(409, "この招待はすでに応答済みです");
      hub.notifyUsers([invite.from, invite.to]);
      return viewInvitation(updated);
    }),
  );
}
