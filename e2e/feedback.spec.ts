import { expect, type Locator, type Page } from "@playwright/test";
import { createSessionAndWorkspace, test } from "./helpers";

// 使ってみて出た指摘への対応：3D パネルの操作、スクリプトの問題の表示、プロジェクト名の変更

const panel = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);

/** ポインターロックを避けるため、要素の中心を実際のマウスでクリックする（3D パネルのヒット判定も確かめる） */
async function mouseClick(page: Page, target: Locator) {
  const b = await target.boundingBox();
  if (!b) throw new Error("見えていません");
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

const pinOf = (page: Page, name: string) =>
  panel(page, name).getByRole("button", { name: /^ピン留め/ });

test("3D にしたパネルは重ならずに操作でき、画面に戻せる", async ({ page }) => {
  await createSessionAndWorkspace(page, "れにうむ", "sample");
  const names = ["Resources", "Inspector", "ワークスペース"];

  // 何枚 3D にしても、それぞれのボタンが押せる
  for (const name of names) {
    await mouseClick(page, pinOf(page, name));
    await expect(pinOf(page, name)).toHaveAttribute("aria-pressed", "false");
  }
  await mouseClick(page, panel(page, "Resources").getByRole("tab", { name: "System" }));
  await expect(panel(page, "Resources").getByRole("tab", { name: "System" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  for (const name of names) {
    await mouseClick(page, pinOf(page, name));
    await expect(pinOf(page, name)).toHaveAttribute("aria-pressed", "true");
  }

  // 3D のパネルがどこにあっても、画面の一覧から戻せる
  for (const name of names) await mouseClick(page, pinOf(page, name));
  const tray = page.getByRole("toolbar", { name: "空間に置いたパネル" });
  await expect(tray.getByRole("button")).toHaveCount(names.length + 1);
  await tray.getByRole("button", { name: "すべて画面に戻す" }).click();
  for (const name of names) await expect(pinOf(page, name)).toHaveAttribute("aria-pressed", "true");
  await expect(tray).toHaveCount(0);
});

test("スクリプトの問題が、Play 前にも実行後にも行番号つきで出る", async ({ page }) => {
  await createSessionAndWorkspace(page, "れにうむ", "sample");
  const main = panel(page, "ワークスペース");
  const res = panel(page, "Resources");
  await res.getByRole("tab", { name: "System" }).click();
  await res.getByRole("button", { name: /^Shoot/ }).click();
  await panel(page, "Inspector").getByRole("button", { name: "コードを開く" }).click();
  const editor = panel(page, "コード").locator(".cm-content");

  // 構文の誤り：Play しなくても出る。クリックするとその行へ
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.insertText("  const x = ;\n");
  const problems = main.getByRole("region", { name: "問題" });
  await expect(problems).toContainText("Shoot.js 3 行目");
  await expect(problems).toContainText("SyntaxError");
  await expect(res.getByText("エラー")).toBeVisible();
  await expect(panel(page, "コード").locator(".cm-tk-errorLine")).toHaveCount(1);

  // 直すと消える
  await page.keyboard.press("ControlOrMeta+z");
  await expect(problems).toHaveCount(0);

  // 実行時の例外：止まった System は、Stop しても次の Play まで残る
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.insertText("    notDefined();\n");
  await main.getByRole("button", { name: /Play/ }).click();
  await expect(problems).toContainText("実行して停止");
  await expect(problems).toContainText("Shoot.js 7 行目");
  await expect(problems).toContainText("notDefined");
  await main.getByRole("button", { name: /Stop/ }).click();
  await expect(main.getByText("Edit mode")).toBeVisible();
  await expect(problems).toContainText("実行して停止");
});

test("プロジェクト名を、ワークスペースとプロジェクトのページで変えられる", async ({ page }) => {
  await createSessionAndWorkspace(page, "れにうむ", "sample");
  const main = panel(page, "ワークスペース");
  await main.getByRole("button", { name: "プロジェクト名を変える" }).click();
  await main.getByLabel("プロジェクト名").fill("的あてゲーム");
  await main.getByLabel("プロジェクト名").press("Enter");
  await expect(main.getByText("的あてゲーム", { exact: true })).toBeVisible();

  const repoId = await page.evaluate(() =>
    (window as unknown as { __workspace: any }).__workspace
      .getState()
      .workspaceId.replace(/^w_/, ""),
  );
  const web = await page.context().newPage();
  await web.goto(`/p/${repoId}`);
  await expect(web.getByRole("heading", { level: 1 })).toContainText("的あてゲーム");
  await web.getByRole("tab", { name: "Settings" }).click();
  await web.getByLabel("プロジェクト名").fill("射的");
  await web.getByRole("button", { name: "名前を変える" }).click();
  await expect(web.getByRole("heading", { level: 1 })).toContainText("射的");
  // 開いているワークスペースにも反映される
  await expect(main.getByText("射的", { exact: true })).toBeVisible();
  await web.close();
});
