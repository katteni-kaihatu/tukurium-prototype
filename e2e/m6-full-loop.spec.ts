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

// M6：「銃と的のミニゲーム」を 3 人で一周する
// 作る → 一緒に編集 → セッションに出して遊ぶ → 遊んでいる横で改造して適用 → コミット → 作品として公開 → ライブラリから置く

test.describe.configure({ timeout: 240_000 });
const panel = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);

async function join(browser: Browser, path: string, name: string) {
  const page = await newPerson(browser, name);
  await page.goto(path);
  await expect(page.getByRole("button", { name: "ワークスペース", exact: true })).toBeVisible();
  await expect(panel(page, "Inspector")).toHaveCount(0);
  return page;
}

test("3 人で、作って・遊んで・改造して・公開するまでを一周する", async ({ page: a, browser }) => {
  // 1. れにうむがサンプルから作り、ここあが一緒に編集する
  const path = await createSessionAndWorkspace(a, "れにうむ", "sample");
  const b = await join(browser, path, "ここあ");
  await b.getByRole("button", { name: "ワークスペース", exact: true }).click();
  await b
    .getByRole("region", { name: "制作を始める" })
    .getByRole("list", { name: "このセッションのワークスペース" })
    .getByRole("button", { name: /^銃と的/ })
    .first()
    .click();
  const binsp = panel(b, "Inspector");
  await binsp.waitFor();
  await binsp.getByRole("button", { name: "的1" }).click();
  await binsp.getByLabel("Name").fill("赤い的");
  await binsp.getByLabel("Name").press("Enter");
  await expect(panel(a, "Inspector").getByRole("button", { name: "赤い的" })).toBeVisible();

  // 2. セッションに出す（再生の横の「セッション同期」から）
  const main = panel(a, "ワークスペース");
  await standAt(a, [0, 0, 6], 0);
  await main.getByRole("button", { name: "セッション同期" }).click();
  const sessionPanel = panel(a, "セッション同期");
  await sessionPanel.getByRole("button", { name: "セッションに出す" }).click();
  await expect(sessionPanel.getByLabel("リンク先一覧").locator("li")).toHaveCount(1);

  // 3. 後から来たかかおは、ワークスペースを開かずにセッションの世界で遊ぶ
  const c = await join(browser, path, "かかお");
  await standAt(c, [0, 0, 6], 0);
  await aimAt(c, [0, 1.5, -2]);
  await fireInSession(c);
  await expect.poll(async () => (await sessionState(a, "的2", "Target"))?.hp).toBe(2);
  await expect.poll(async () => (await sessionState(a, "銃", "Gun"))?.ammo).toBe(11);

  // 4. 遊んでいる横で、ここあが威力を上げて適用する（残弾は保つ）
  await binsp.getByRole("button", { name: "銃", exact: true }).click();
  await binsp.getByLabel("damage", { exact: true }).fill("5");
  await binsp.getByLabel("damage", { exact: true }).press("Enter");
  const bmain = panel(b, "ワークスペース");
  await bmain.getByRole("button", { name: "セッション同期" }).click();
  await panel(b, "セッション同期").getByRole("button", { name: "適用" }).click();
  await expect.poll(async () => (await sessionState(a, "銃", "Gun"))?.damage).toBe(5);
  expect((await sessionState(a, "銃", "Gun"))?.ammo).toBe(11);
  await fireInSession(c);
  await expect
    .poll(async () => (await sessionState(a, "的2", "Target"))?.hp)
    .toBeLessThanOrEqual(0);

  // 5. れにうむが保存する（一緒に編集したここあが Co-author）
  await main.getByRole("button", { name: "保存", exact: true }).click();
  const save = panel(a, "保存");
  await save.getByLabel("メッセージ").fill("的の名前と威力を調整");
  await save.getByRole("button", { name: "保存", exact: true }).click();
  await main.getByRole("button", { name: "履歴", exact: true }).click();
  const hist = panel(a, "履歴");
  await expect(hist.getByRole("button", { name: /的の名前と威力を調整/ })).toBeVisible();

  // 6. プロジェクトのページで作品として公開し、リリースする（別のタブで）
  const repoId = await a.evaluate(() =>
    (window as unknown as { __workspace: any }).__workspace
      .getState()
      .workspaceId.replace(/^w_/, ""),
  );
  const web = await a.context().newPage();
  await web.goto(`/p/${repoId}`);
  await web.getByRole("tab", { name: "Commits" }).click();
  await expect(web.getByLabel("コミット")).toContainText("共同制作");
  await web.getByRole("tab", { name: "Releases" }).click();
  await web.getByRole("button", { name: "作品として公開" }).click();
  await web.getByRole("button", { name: "最新のコミットからリリース" }).click();
  await expect(web.getByLabel("射撃場 のリリース")).toContainText("v1");
  await web.close();

  // 7. かかおがライブラリから、公開された作品を同じセッションに置く
  await c.getByRole("button", { name: "ライブラリ", exact: true }).click();
  const lib = panel(c, "ライブラリ");
  await lib.getByLabel("作品").getByRole("button", { name: "セッションに置く" }).first().click();
  await expect(lib.getByLabel("置いた作品")).toContainText("射撃場 v1");
  await expect
    .poll(() =>
      a.evaluate(
        () => (window as unknown as { __app: any }).__app.getState().session.placements.length,
      ),
    )
    .toBe(2);
});
