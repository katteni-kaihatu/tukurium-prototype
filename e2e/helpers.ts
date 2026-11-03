import { type Browser, type BrowserContext, test as base, type Page } from "@playwright/test";

const extraContexts: BrowserContext[] = [];

/** 2 人目以降の参加者（別のブラウザコンテキスト）。テストの終わりに closePeople で閉じる */
export async function newPerson(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  extraContexts.push(ctx);
  const page = await ctx.newPage();
  await page.addInitScript((n) => localStorage.setItem("tukurium.name", n), name);
  return page;
}

/**
 * E2E ではこの test を使う（@playwright/test の test を直接使わない。biome で禁止している）。
 * newPerson で開いた 2 人目以降のコンテキストを、テストの終わりに必ず閉じる。
 * 閉じないとブラウザはワーカーの間ずっと共有されるので、前のテストの画面が描画を続けて重くなり、
 * 後のテストが時間切れで落ちる（M5 で実際に起きた）。
 */
export const test = base.extend<{ closePeople: undefined }>({
  closePeople: [
    async ({ browser: _ }, use) => {
      await use(undefined);
      await Promise.all(extraContexts.splice(0).map((c) => c.close()));
    },
    { auto: true },
  ],
});

/** 開発時に window に出しているストアとエンジンを使う（apps/client の DEV 専用フック） */
export async function aimAt(page: Page, target: [number, number, number]): Promise<void> {
  await page.evaluate((t) => {
    const e = (window as unknown as { __tukurium: any }).__tukurium;
    const c = e.controller;
    const p = c.position;
    const dx = t[0] - p.x;
    const dz = t[2] - p.z;
    c.yaw = Math.atan2(-dx, -dz);
    c.pitch = Math.atan2(t[1] - (p.y + 1.6), Math.hypot(dx, dz));
  }, target);
  // カメラの向きは描画のフレームで反映されるので、2 フレーム待つ
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** 視線の先へ fire を入力する（ポインターロックはヘッドレスでは不安定なので、入力を直接渡す） */
export async function fire(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tukurium: any; __workspace: any };
    const cam = w.__tukurium.camera;
    const o = cam.getWorldPosition(cam.position.clone());
    const d = cam.getWorldDirection(cam.position.clone());
    w.__workspace.getState().sim.input({
      action: "fire",
      phase: "down",
      player: "e2e",
      origin: o.toArray(),
      direction: d.toArray(),
    });
  });
  await page.waitForTimeout(150);
}

/** 実行中の World で、名前で Entity を探して KokoState の値（フィールド名）を返す */
export async function runtimeState(page: Page, entityName: string, koko: string) {
  return page.evaluate(
    ([name, kokoName]) => {
      // ホストは手元の Simulation、ほかの人はホストから届いた状態
      const rt = (window as unknown as { __workspace: any }).__workspace.getState().runtime();
      if (!rt) return null;
      const id = rt.world.entityIds().find((x: string) => rt.nameOf(x) === name);
      const kid = rt.world.registry.idOf(kokoName);
      const def = rt.world.registry.get(kid);
      const v = rt.world.get(id, kid);
      if (!v) return null;
      return Object.fromEntries(
        def.fields.map((f: { id: string; name: string }) => [f.name, v[f.id]]),
      );
    },
    [entityName, koko] as const,
  );
}

/** ホームからセッションを作って入り、ワークスペースを作る */
export async function createSessionAndWorkspace(
  page: Page,
  name: string,
  kind: "sample" | "empty",
): Promise<string> {
  await page.addInitScript((n) => localStorage.setItem("tukurium.name", n), name);
  await page.goto("/");
  await page.getByRole("button", { name: "セッションを作って入る" }).click();
  await page.waitForURL(/\/s\/s_/);
  await page
    .getByRole("button", {
      name: kind === "sample" ? /サンプル「銃と的」で作る/ : /空のワークスペース/,
    })
    .click();
  await page.locator('section[aria-label="Inspector"]').waitFor();
  return new URL(page.url()).pathname;
}

/** セッションの世界で、名前で Entity を探して KokoState の値を返す（ホストは Simulation、ほかは届いた状態） */
export async function sessionState(page: Page, entityName: string, kokoName: string) {
  return page.evaluate(
    ([name, koko]) => {
      const s = (window as unknown as { __sessionWorld: any }).__sessionWorld.getState();
      const sim = s.sim;
      if (sim) {
        const id = sim.world.entityIds().find((x: string) => sim.nameOf(x) === name);
        if (!id) return null;
        const kid = sim.world.statesOf(id).find((k: string) => sim.registry.get(k)?.name === koko);
        if (!kid) return null;
        const def = sim.registry.get(kid);
        const v = sim.world.get(id, kid);
        return Object.fromEntries(
          def.fields.map((f: { id: string; name: string }) => [f.name, v[f.id]]),
        );
      }
      if (!s.remote) return null;
      const id = Object.keys(s.remote.names).find((x) => s.remote.names[x] === name);
      if (!id) return null;
      const states = s.remote.world.statesOf(id);
      // 届いた状態にはフィールド名がないので、値（フィールド ID）をそのまま返す
      const kid = states.find((k: string) => k.endsWith(`:ks_${koko.toLowerCase()}`));
      return kid ? s.remote.world.get(id, kid) : null;
    },
    [entityName, kokoName] as const,
  );
}

/** セッションの世界へ、視線の先に向けて入力を送る */
export async function fireInSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tukurium: any; __sessionWorld: any };
    const cam = w.__tukurium.camera;
    const o = cam.getWorldPosition(cam.position.clone());
    const d = cam.getWorldDirection(cam.position.clone());
    w.__sessionWorld.getState().input({
      action: "fire",
      phase: "down",
      player: "e2e",
      origin: o.toArray(),
      direction: d.toArray(),
    });
  });
}

/** プレイヤーの位置と向きを決める（yaw はラジアン、0 で -Z を向く） */
export async function standAt(
  page: Page,
  position: [number, number, number],
  yaw = 0,
): Promise<void> {
  await page.evaluate(
    ([p, y]) => {
      const c = (window as unknown as { __tukurium: any }).__tukurium.controller;
      c.position.set(p[0], p[1], p[2]);
      c.yaw = y;
      c.pitch = 0;
    },
    [position, yaw] as const,
  );
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}
