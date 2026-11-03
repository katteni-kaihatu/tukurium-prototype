import { type Browser, expect, type Page, test } from "@playwright/test";
import { createSessionAndWorkspace } from "./helpers";

// M4 の完了条件：作品を公開し、別の人がフォーク・抽出して作り始められる（シナリオ 10・11）

test.describe.configure({ timeout: 150_000 });

const panel = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);

async function person(browser: Browser, name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript((n) => localStorage.setItem("tukurium.name", n), name);
  return page;
}

test("コミット → 作品として公開・リリース → 別の人がフォーク・抽出・セッションに置く", async ({
  page: a,
  browser,
}) => {
  await createSessionAndWorkspace(a, "れにうむ", "sample");
  const repoId = await a.evaluate(() => {
    const w = window as unknown as { __workspace: any };
    return w.__workspace.getState().workspaceId.replace(/^w_/, "");
  });

  // 編集して、History からメッセージ付きでコミットする
  const insp = panel(a, "Inspector");
  await insp.getByRole("button", { name: "的1" }).click();
  await insp.getByLabel("Name").fill("大きな的");
  await insp.getByLabel("Name").press("Enter");
  await panel(a, "ワークスペース").getByRole("button", { name: "History" }).click();
  const hist = panel(a, "History");
  await expect(hist.getByLabel("未コミットの変更").locator("li")).toHaveCount(1);
  await hist.getByLabel("コミットメッセージ").fill("的の名前を変えた");
  await hist.getByRole("button", { name: "コミット", exact: true }).click();
  await expect(hist.getByLabel("コミットの履歴").locator("li").first()).toContainText(
    "的の名前を変えた",
  );
  await expect(hist.getByText("すべてコミット済みです")).toBeVisible();

  // プロジェクトのページで、作品として公開し、リリースする
  await a.goto(`/p/${repoId}`);
  await a.getByRole("tab", { name: "Commits" }).click();
  await expect(a.getByLabel("コミット")).toContainText("的の名前を変えた");
  await a.getByRole("tab", { name: "Releases" }).click();
  await a.getByRole("button", { name: "作品として公開" }).click();
  await a.getByRole("button", { name: "最新のコミットからリリース" }).click();
  await expect(a.getByLabel("射撃場 のリリース")).toContainText("v1");

  // 別の人（ここあ）が探す → フォーク
  const b = await person(browser, "ここあ");
  await b.goto("/explore");
  await expect(b.getByLabel("作品")).toContainText("射撃場");
  await b.getByLabel("作品").getByRole("link", { name: "射撃場" }).click();
  await b.getByRole("button", { name: "Fork" }).click();
  await expect(b.getByText("フォーク元：").first()).toBeVisible();
  await expect(b.getByRole("heading", { level: 1 })).toContainText("ここあ");

  // 元のプロジェクトから System だけを抽出して、新しいプロジェクトを作る
  await b.goto(`/p/${repoId}`);
  await b.getByRole("button", { name: "抽出…" }).click();
  const dialog = b.getByRole("dialog", { name: "抽出" });
  await dialog.getByLabel("Shoot").check();
  await dialog.getByLabel("新しいプロジェクトの名前").fill("銃の仕組み");
  await dialog.getByRole("button", { name: /件を抽出/ }).click();
  await expect(b.getByRole("heading", { level: 1 })).toContainText("銃の仕組み");
  await expect(b.getByLabel("About")).toContainText("抽出元");
  await expect(b.getByLabel("About")).toContainText("Shoot");

  // ここあのセッションに、作品のリリースを置く
  await b.goto("/");
  await b.getByRole("button", { name: "セッションを作って入る" }).click();
  await b.waitForURL(/\/s\/s_/);
  await b.getByRole("button", { name: "ライブラリ" }).click();
  const lib = panel(b, "ライブラリ");
  await lib.getByLabel("作品").getByRole("button", { name: "セッションに置く" }).click();
  await expect(lib.getByLabel("置いた作品")).toContainText("射撃場 v1");
  await expect
    .poll(() =>
      b.evaluate(() => {
        const s = (window as unknown as { __sessionWorld: any }).__sessionWorld.getState().sim;
        return s ? s.world.entityIds().length : 0;
      }),
    )
    .toBeGreaterThan(0);
});
