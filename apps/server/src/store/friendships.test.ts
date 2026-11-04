import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresStore } from "./postgres";
import { MemoryStore, type Store } from "./store";

for (const [name, create] of [
  ["MemoryStore", () => new MemoryStore()],
  [
    "PostgresStore",
    process.env.TEST_DATABASE_URL
      ? () => new PostgresStore(process.env.TEST_DATABASE_URL as string)
      : null,
  ],
] as const) {
  describe(name, () => {
    it.skipIf(!create)("申請を重複させず、受け手だけが承認し、解除と状態を保存する", async () => {
      const store: Store = (create as () => Store)();
      await store.init();
      const a = `a_${randomUUID()}`,
        b = `b_${randomUUID()}`;
      const request = {
        from: a,
        to: b,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      };
      try {
        const [first, second] = await Promise.all([
          store.requestFriendship(request),
          store.requestFriendship(request),
        ]);
        expect(first).toEqual(second);
        expect((await store.requestFriendship({ ...request, from: b, to: a })).status).toBe(
          "pending",
        );
        expect(await store.friendships(a)).toHaveLength(1);
        expect(await store.acceptFriendship(a, b)).toBeNull();
        expect((await store.acceptFriendship(b, a))?.status).toBe("accepted");
        expect((await store.friendships(a))[0]?.status).toBe("accepted");
        await store.saveSocialProfile(a, { availability: "busy", note: "制作中" });
        expect(await store.socialProfile(a)).toEqual({ availability: "busy", note: "制作中" });
        await store.removeFriendship(b, a);
        expect(await store.friendships(a)).toEqual([]);
      } finally {
        await store.close();
      }
      if (name === "PostgresStore") {
        const reopened = (create as () => Store)();
        await reopened.init();
        try {
          expect(await reopened.socialProfile(a)).toEqual({ availability: "busy", note: "制作中" });
          expect(await reopened.friendships(a)).toEqual([]);
        } finally {
          await reopened.close();
        }
      }
    });
  });
}
