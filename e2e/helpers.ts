import type { Page } from "@playwright/test";

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
