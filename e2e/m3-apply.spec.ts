import { type Browser, expect, type Page } from "@playwright/test";
import {
  aimAt,
  createSessionAndWorkspace,
  fireInSession,
  newPerson,
  sessionState,
  standAt,
  test,
} from "./helpers";

// M3 の完了条件：遊んでいる人がいる横で銃を改造し、適用すると残弾だけ保ったまま新しい挙動になる
// （シナリオ 2・6・7・8）

// 2 つのブラウザでソフトウェア描画するため、手順の長いこのファイルは上限を延ばす
test.describe.configure({ timeout: 150_000 });

const panel = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);

async function join(browser: Browser, path: string, name: string) {
  const page = await newPerson(browser, name);
  await page.goto(path);
  await page.locator('section[aria-label="ワークスペース"]').waitFor();
  return page;
}

const sessionTime = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __sessionWorld: any }).__sessionWorld.getState().sim?.time ?? 0,
  );

test("遊んでいる人の横で改造して適用すると、残弾は保ったまま新しい威力になる", async ({
  page: a,
  browser,
}) => {
  const path = await createSessionAndWorkspace(a, "れにうむ", "sample");
  const main = panel(a, "ワークスペース");
  await standAt(a, [0, 0, 6], 0);
  await main.getByRole("button", { name: "セッションに出す" }).click();
  await expect(main.getByLabel("リンク先一覧").locator("li")).toHaveCount(1);

  // b はワークスペースを開かずに、セッションの世界で遊ぶ
  const b = await join(browser, path, "ここあ");
  await standAt(b, [0, 0, 6], 0);
  await aimAt(b, [0, 1.5, -2]);
  await fireInSession(b);
  await expect.poll(async () => (await sessionState(a, "的2", "Target"))?.hp).toBe(2);
  await expect.poll(async () => (await sessionState(a, "銃", "Gun"))?.ammo).toBe(11);

  // ワークスペースで再生・一時停止しても、セッションの世界は止まらない
  const t0 = await sessionTime(a);
  await main.getByRole("button", { name: /Play/ }).click();
  await expect(main.getByText("Play mode")).toBeVisible();
  await main.getByRole("button", { name: /Pause/ }).click();
  await expect.poll(() => sessionTime(a)).toBeGreaterThan(t0 + 0.2);
  await main.getByRole("button", { name: /Stop/ }).click();
  await expect(main.getByText("Edit mode")).toBeVisible();

  // a が銃を改造（威力 3、残弾の初期値 99）して適用する。残弾は「維持」のマークがある
  const insp = panel(a, "Inspector");
  await insp.getByRole("button", { name: "銃", exact: true }).click();
  await expect(insp.getByRole("button", { name: "Gun.ammo を適用時に引き継ぐ" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await insp.getByLabel("damage", { exact: true }).fill("3");
  await insp.getByLabel("damage", { exact: true }).press("Enter");
  await insp.getByLabel("ammo", { exact: true }).fill("99");
  await insp.getByLabel("ammo", { exact: true }).press("Enter");
  await main.getByRole("button", { name: "適用" }).click();
  await expect.poll(async () => (await sessionState(a, "銃", "Gun"))?.damage).toBe(3);
  expect((await sessionState(a, "銃", "Gun"))?.ammo).toBe(11); // 実行値を保つ
  await expect(main.getByLabel("セッションのログ")).toContainText("適用しました");

  // b がもう一度撃つと、新しい威力で倒れる
  await fireInSession(b);
  await expect
    .poll(async () => (await sessionState(a, "的2", "Target"))?.hp)
    .toBeLessThanOrEqual(0);

  // リセットで初期値（いまの制作データの 99）に戻る
  await main.getByLabel("リンク先一覧").getByRole("button", { name: "リセット" }).click();
  await expect.poll(async () => (await sessionState(a, "銃", "Gun"))?.ammo).toBe(99);
});
