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
    it.skipIf(!create)("同時入手を一件にし、最初の版を保ち、本人の一覧だけを返す", async () => {
      const store: Store = (create as () => Store)();
      const userId = `u_${randomUUID()}`;
      const first = {
        userId,
        workId: "work-1",
        releaseId: "release-1",
        acquiredAt: "2026-11-05T00:00:00.000Z",
      };
      await store.init();
      try {
        const results = await Promise.all([store.acquireItem(first), store.acquireItem(first)]);
        expect(results).toEqual([first, first]);
        expect(await store.acquireItem({ ...first, releaseId: "release-2" })).toEqual(first);
        expect(await store.ownedItems(userId)).toEqual([first]);
        expect(await store.ownedItems(`${userId}-other`)).toEqual([]);
        if (results[0]) results[0].releaseId = "changed";
        expect((await store.ownedItems(userId))[0]?.releaseId).toBe("release-1");
      } finally {
        await store.close();
      }
      if (name === "PostgresStore") {
        const reopened = (create as () => Store)();
        await reopened.init();
        try {
          expect(await reopened.ownedItems(userId)).toEqual([first]);
        } finally {
          await reopened.close();
        }
      }
    });
  });
}
