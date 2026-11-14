import { type Browser, expect, type Page } from "@playwright/test";
import { createSessionAndWorkspace, newPerson, sessionState, test } from "./helpers";

// M6：一緒に作ったものを保存し、リリースして、ライブラリからセッションに置く（公開までのつなぎ）
// 編集・再生（m2）と、セッションに出して適用（m3）はほかのテストで確かめるので、ここでは扱わない。
// 3 人目を開くとソフトウェアの描画で画面が 20 秒ほど止まり不安定だったので、2 人にした（DEVELOPMENT.md）

test.describe.configure({ timeout: 180_000 });
const panel = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);

async function join(browser: Browser, path: string, name: string) {
  const page = await newPerson(browser, name);
  await page.goto(path);
  // 参加した直後は、ソフトウェアでの描画の準備で重い（ボタンが出るまで 5 秒ほどかかることがある）
  await expect(page.getByRole("button", { name: "ワークスペース", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  return page;
}

test("2 人でプレハブを作って保存し、リリースして、ライブラリからセッションに置く", async ({
  page: a,
  browser,
}) => {
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

  // プレハブとインスタンスの上書きも、共同編集から公開した配置まで届く
  await binsp.getByRole("button", { name: "赤い的 をプレハブにする", exact: true }).click();
  await b
    .getByRole("dialog", { name: "赤い的 をプレハブにする" })
    .getByRole("button", { name: "プレハブにする", exact: true })
    .click();
  await binsp.getByLabel("hp", { exact: true }).fill("7");
  await binsp.getByLabel("hp", { exact: true }).press("Enter");
  await expect
    .poll(() =>
      a.evaluate(
        () =>
          (window as unknown as { __workspace: any }).__workspace.getState().project.prefabs()
            .length,
      ),
    )
    .toBe(1);

  // 2. れにうむが保存する（一緒に編集したここあが Co-author）
  const main = panel(a, "ワークスペース");
  await main.getByRole("button", { name: "保存", exact: true }).click();
  const save = panel(a, "保存");
  await save.getByLabel("メッセージ").fill("的をプレハブにして名前と値を変える");
  await save.getByRole("button", { name: "保存", exact: true }).click();
  await main.getByRole("button", { name: "履歴", exact: true }).click();
  await expect(
    panel(a, "履歴").getByRole("button", { name: /的をプレハブにして名前と値を変える/ }),
  ).toBeVisible();

  // 3. プロジェクトのページでリリースし、バージョンを出す（別のタブで）
  const repoId = await a.evaluate(() =>
    (window as unknown as { __workspace: any }).__workspace
      .getState()
      .workspaceId.replace(/^w_/, ""),
  );
  const web = await a.context().newPage();
  await web.goto(`/p/${repoId}`);
  await web.getByRole("tab", { name: "履歴" }).click();
  await expect(web.getByLabel("履歴", { exact: true })).toContainText("共同制作");
  await web.getByRole("tab", { name: "リリース" }).click();
  await web.getByRole("button", { name: "リリースする" }).click();
  await web.getByRole("button", { name: "最新のコミットからバージョンを出す" }).click();
  await expect(web.getByLabel("射撃場 のリリース")).toContainText("v1");
  await web.close();

  // 4. ここあがライブラリから、リリースを同じセッションに置く。れにうむにも届く
  await b.getByRole("button", { name: "ライブラリ", exact: true }).click();
  const lib = panel(b, "ライブラリ");
  await lib
    .getByLabel("リリース")
    .getByRole("button", { name: "セッションに置く" })
    .first()
    .click();
  await expect(lib.getByLabel("置いた作品")).toContainText("射撃場 v1");
  await expect
    .poll(() =>
      a.evaluate(
        () => (window as unknown as { __app: any }).__app.getState().session.placements.length,
      ),
    )
    .toBe(1);
  await expect.poll(async () => (await sessionState(a, "赤い的", "Target"))?.hp).toBe(7);
});
