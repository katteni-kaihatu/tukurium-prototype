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
      "同時入手を一件にし、最初の版を保ち、版の差し替えと削除ができ、本人の一覧だけを返す",
      async () => {
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
          const updated = { ...first, releaseId: "release-2" };
          expect(await store.updateOwnedItem(userId, "work-1", "release-2")).toEqual(updated);
          expect(await store.ownedItems(userId)).toEqual([updated]);
          expect(await store.updateOwnedItem(userId, "work-missing", "release-2")).toBeNull();
          if (name === "MemoryStore") {
            await store.removeOwnedItem(userId, "work-1");
            expect(await store.ownedItems(userId)).toEqual([]);
          }
        } finally {
          await store.close();
        }
        if (name === "PostgresStore") {
          const reopened = (create as () => Store)();
          await reopened.init();
          try {
            expect(await reopened.ownedItems(userId)).toEqual([
              { ...first, releaseId: "release-2" },
            ]);
            await reopened.removeOwnedItem(userId, "work-1");
            await reopened.removeOwnedItem(userId, "work-1");
            expect(await reopened.ownedItems(userId)).toEqual([]);
          } finally {
            await reopened.close();
          }
        }
      },
    );

    it.skipIf(!create)("同時に買っても一回だけ払い、足りなければ何も変えない", async () => {
      const store: Store = (create as () => Store)();
      const buyer = `u_${randomUUID()}`;
      const seller = `u_${randomUUID()}`;
      const workId = `work-${randomUUID()}`;
      const item = { userId: buyer, workId, releaseId: "r1", acquiredAt: "2026-11-13T00:00:00Z" };
      const sale = (id: string, price: number) => ({
        id,
        workId,
        sellerId: seller,
        buyerId: buyer,
        releaseId: "r1",
        price,
        earned: Math.floor(price * 0.9),
        at: "2026-11-13T00:00:00Z",
      });
      await store.init();
      try {
        expect(await store.balance(buyer)).toBe(1000);
        const tooMuch = await store.purchase(item, sale(`s-${randomUUID()}`, 1001));
        expect(tooMuch).toEqual({ ok: false, reason: "funds", balance: 1000 });
        expect(await store.ownedItems(buyer)).toEqual([]);
        const results = await Promise.all([
          store.purchase(item, sale(`s-${randomUUID()}`, 300)),
          store.purchase(item, sale(`s-${randomUUID()}`, 300)),
        ]);
        expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
        expect(await store.balance(buyer)).toBe(700);
        expect(await store.balance(seller)).toBe(1270);
        expect(await store.sales({ sellerId: seller })).toHaveLength(1);
        expect(await store.ownedItems(buyer)).toEqual([item]);
      } finally {
        await store.close();
      }
    });
  });
}
