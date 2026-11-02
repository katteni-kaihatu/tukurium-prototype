import { type Browser, expect, type Page, test } from "@playwright/test";
import { aimAt, createSessionAndWorkspace, fire, runtimeState } from "./helpers";

// M2 の完了条件：2 人が同じワークスペースを編集・再生し、相手のパネルが空間に見える（シナリオ 1, 5）

const panel = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);

async function join(browser: Browser, path: string, name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript((n) => localStorage.setItem("tukurium.name", n), name);
  await page.goto(path);
  return page;
}

test("2 人で同じワークスペースを編集し、再生を共有し、相手のパネルが見える", async ({
  page: a,
  browser,
}) => {
  const path = await createSessionAndWorkspace(a, "れにうむ", "sample");
  const b = await join(browser, path, "ここあ");

  // b はセッションに入り、ワークスペースを開く（既定の権限＝共同編集）
  await panel(b, "ワークスペース")
    .getByRole("button", { name: /^銃と的/ })
    .click();
  await panel(b, "Inspector").waitFor();
  await expect(panel(b, "ワークスペース").getByText("共同編集")).toBeVisible();
  await expect(
    panel(b, "ワークスペース").getByText("再生の実行（ホスト）: れにうむ"),
  ).toBeVisible();

  // b が的の名前を変えると a に届く
  const binsp = panel(b, "Inspector");
  await binsp.getByRole("button", { name: "的1" }).click();
  await binsp.getByLabel("Name").fill("赤い的");
  await binsp.getByLabel("Name").press("Enter");
  await expect(panel(a, "Inspector").getByRole("button", { name: "赤い的" })).toBeVisible();

  // b が Play を押すと、ホストの a で再生が始まり、b にも状態が届く
  await panel(b, "ワークスペース").getByRole("button", { name: /Play/ }).click();
  await expect(panel(a, "ワークスペース").getByText("Play mode")).toBeVisible();
  await expect(panel(b, "ワークスペース").getByText("Play mode")).toBeVisible();

  // b が撃つ → 入力はホストへ → 命中が両方に見える
  await aimAt(b, [0, 1.5, -5]);
  await b.evaluate(() => {
    const w = window as unknown as { __tukurium: any; __workspace: any };
    const cam = w.__tukurium.camera;
    const o = cam.getWorldPosition(cam.position.clone());
    const d = cam.getWorldDirection(cam.position.clone());
    w.__workspace.getState().input({
      action: "fire",
      phase: "down",
      player: "b",
      origin: o.toArray(),
      direction: d.toArray(),
    });
  });
  await expect.poll(async () => (await runtimeState(a, "的2", "Target"))?.hp).toBe(2);
  await expect.poll(async () => (await runtimeState(b, "的2", "Target"))?.hp).toBe(2);

  // ホストの a 自身も撃てる（直前の射撃のクールダウン 0.2 秒が明けるまで待つ）
  await a.waitForTimeout(600);
  await aimAt(a, [1.6, 1.5, -5]);
  await fire(a);
  await expect.poll(async () => (await runtimeState(b, "的3", "Target"))?.hp).toBe(2);

  // a のパネルが b の空間に見える（要約が届いている）
  await expect
    .poll(() =>
      b.evaluate(() => {
        const s = (window as unknown as { __app?: any }).__app;
        return s ? Object.values(s.getState().remotePanels).flat().length : -1;
      }),
    )
    .toBeGreaterThan(0);

  // Stop は全員に届く
  await panel(a, "ワークスペース").getByRole("button", { name: /Stop/ }).click();
  await expect(panel(b, "ワークスペース").getByText("Edit mode")).toBeVisible();
});

test("ホストが抜けたら、管理権限を持つ人が再生を引き継ぐ", async ({ page: a, browser }) => {
  const path = await createSessionAndWorkspace(a, "れにうむ", "sample");
  const b = await join(browser, path, "ここあ");
  await panel(b, "ワークスペース")
    .getByRole("button", { name: /^銃と的/ })
    .click();
  await panel(b, "Inspector").waitFor();

  // a が b を管理者にする
  await panel(a, "ワークスペース").getByRole("button", { name: "Members" }).click();
  await panel(a, "Members").getByLabel("ここあ の権限").selectOption("admin");
  await expect(panel(b, "ワークスペース").getByText("管理", { exact: true })).toBeVisible();

  await panel(a, "ワークスペース").getByRole("button", { name: /Play/ }).click();
  await expect(panel(b, "ワークスペース").getByText("Play mode")).toBeVisible();
  await aimAt(a, [0, 1.5, -5]);
  await fire(a);
  await expect.poll(async () => (await runtimeState(b, "的2", "Target"))?.hp).toBe(2);

  // a がワークスペースを閉じる → b がホストになり、状態（hp 2）を保ったまま続く
  await a.evaluate(() =>
    (window as unknown as { __workspace: any }).__workspace.getState().leave(),
  );
  await expect(panel(b, "ワークスペース").getByText("再生の実行（ホスト）: あなた")).toBeVisible();
  await expect(panel(b, "ワークスペース").getByText("Play mode")).toBeVisible();
  await expect.poll(async () => (await runtimeState(b, "的2", "Target"))?.hp).toBe(2);
});
