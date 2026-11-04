import { isOfficial } from "@tukurium/repo-model";
import { SocialProfile } from "@tukurium/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Hub } from "../hub";
import { HttpError } from "../repos/service";
import type { Store, User } from "../store/store";

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
      return { profile: await store.socialProfile(user.id), friends, incoming, outgoing };
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
      hub.notifyUsers([user.id, other.id]);
      return { ok: true };
    }),
  );
}
