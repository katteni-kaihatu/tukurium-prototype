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
    it.skipIf(!create)(
      "招待の重複・応答者・期限を確認し、応答済みの招待を上書きしない",
      async () => {
        const store: Store = (create as () => Store)();
        await store.init();
        const from = randomUUID(),
          to = randomUUID();
        const invitation = {
          id: randomUUID(),
          from,
          to,
          sessionId: "room",
          status: "pending" as const,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        try {
          const [a, b] = await Promise.all([
            store.createInvitation(invitation),
            store.createInvitation({ ...invitation, id: randomUUID() }),
          ]);
          expect(a.id).toBe(b.id);
          expect(await store.respondInvitation(a.id, from, "accepted")).toBeNull();
          expect((await store.respondInvitation(a.id, to, "accepted"))?.status).toBe("accepted");
          expect(await store.respondInvitation(a.id, to, "declined")).toBeNull();
          const expired = await store.createInvitation({
            ...invitation,
            id: randomUUID(),
            sessionId: "expired",
            expiresAt: "2020-01-01T00:00:00.000Z",
          });
          expect(await store.respondInvitation(expired.id, to, "accepted")).toBeNull();
          expect((await store.invitations(to)).find((i) => i.id === a.id)?.status).toBe("accepted");
        } finally {
          await store.close();
        }
        if (name === "PostgresStore") {
          const reopened = (create as () => Store)();
          await reopened.init();
          try {
            expect((await reopened.invitations(to)).some((i) => i.status === "accepted")).toBe(
              true,
            );
          } finally {
            await reopened.close();
          }
        }
      },
    );
  });
}
