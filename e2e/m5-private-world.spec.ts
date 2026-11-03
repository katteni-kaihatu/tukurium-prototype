import { type Browser, expect, type Page, test } from "@playwright/test";
import { closePeople, createSessionAndWorkspace, newPerson, standAt } from "./helpers";

// M5 の完了条件：
// - シナリオ 9：権限のない人にはプライベート作業の内容が表示・配信されず、専用空間にも入れない
// - シナリオ 12：ワールドの編集空間へポータルで入り、制作・出力できる

// 2 人分のブラウザで動かすので、全体を流すと重くなる
test.describe.configure({ timeout: 150_000 });

test.afterEach(closePeople);

const panel = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);

async function join(browser: Browser, path: string, name: string) {
  const page = await newPerson(browser, name);
  await page.goto(path);
  await panel(page, "ワークスペース").waitFor();
  return page;
}

const myX = (page: Page) =>
  page.evaluate(() => (window as unknown as { __tukurium: any }).__tukurium.controller.position.x);

/** 自分が開いていないワークスペースの見た目（restricted と中身の有無、ポータルの有無） */
const previews = (page: Page) =>
  page.evaluate(() =>
    [...(window as unknown as { __previews: any }).__previews.entries.values()].map((e: any) => ({
      restricted: e.restricted,
      hasView: e.view !== null,
      hasPortal: e.portal !== null,
      world: e.preview.world !== null,
    })),
  );

test("非公開の作業は、権限のない人には中身が届かず、専用空間にも入れない", async ({
  page: a,
  browser,
}) => {
  const path = await createSessionAndWorkspace(a, "れにうむ", "sample");
  const b = await join(browser, path, "ここあ");

  // 公開（既定は共同編集）の間は、開いていなくても中身が見える
  await expect
    .poll(() => previews(b), { timeout: 15_000 })
    .toEqual([{ restricted: false, hasView: true, hasPortal: false, world: true }]);

  // 非公開にすると、a は独立した空間へ移り、b には「作業中」の境界だけが届く
  await panel(a, "ワークスペース").getByRole("button", { name: "Members" }).click();
  await panel(a, "Members").getByLabel("参加者の初期値").selectOption("");
  await expect.poll(() => myX(a)).toBeGreaterThan(400);
  await expect(panel(a, "ワークスペース").getByText("非公開の作業：独立した空間")).toBeVisible();
  await expect(
    panel(a, "ワークスペース").getByRole("button", { name: "セッションに出す" }),
  ).toBeDisabled();
  await expect
    .poll(() => previews(b), { timeout: 15_000 })
    .toEqual([{ restricted: true, hasView: false, hasPortal: false, world: false }]);

  // b は開けない
  await panel(b, "ワークスペース")
    .getByRole("button", { name: /^銃と的 .*非公開/ })
    .click();
  await expect(
    panel(b, "ワークスペース")
      .getByText(/非公開の作業です|非公開/)
      .first(),
  ).toBeVisible();
  await expect
    .poll(() => b.evaluate(() => (window as any).__workspace.getState().ready))
    .toBe(false);

  // a はセッションに戻れる
  await panel(a, "ワークスペース").getByRole("button", { name: "セッションに戻る" }).click();
  await expect.poll(() => myX(a)).toBeLessThan(50);
});

test("ワールドの編集空間へポータルで入り、作ってセッションに出す", async ({ page: a, browser }) => {
  const path = await createSessionAndWorkspace(a, "れにうむ", "empty");
  const main = panel(a, "ワークスペース");

  // ワールドのアウトプットを作ると、独立した空間に移る
  await main.getByLabel("アウトプット").selectOption("__newWorld");
  await expect(main.getByText("Output · world")).toBeVisible();
  await expect.poll(() => myX(a)).toBeLessThan(-400);
  await expect(main.getByText("ワールドの編集：独立した空間")).toBeVisible();

  // 地面を置いて、セッションに出す（ワールドはセッションの原点に置かれる）
  const insp = panel(a, "Inspector");
  await insp.getByRole("button", { name: "Entity を追加" }).click();
  await insp.getByRole("button", { name: "ボックス" }).click();
  await insp.getByLabel("Name").fill("地面");
  await insp.getByLabel("Name").press("Enter");
  await main.getByRole("button", { name: "セッションに出す" }).click();
  await expect
    .poll(() =>
      a.evaluate(() => (window as unknown as { __app: any }).__app.getState().session.placements),
    )
    .toMatchObject([{ position: [0, 0, 0], yaw: 0 }]);
  await expect
    .poll(() =>
      a.evaluate(() => {
        const sim = (window as unknown as { __sessionWorld: any }).__sessionWorld.getState().sim;
        return sim?.world.entityIds().map((id: string) => sim.nameOf(id)) ?? [];
      }),
    )
    .toContain("地面");

  // セッションに戻ると、区画にポータルがある。b もポータルから入って中身を見られる
  await main.getByRole("button", { name: "セッションに戻る" }).click();
  await expect.poll(() => myX(a)).toBeGreaterThan(-50);
  const b = await join(browser, path, "ここあ");
  await expect
    .poll(() => previews(b), { timeout: 15_000 })
    .toEqual([{ restricted: false, hasView: true, hasPortal: true, world: true }]);
  await standAt(b, [0, 0, -3]);
  await expect.poll(() => myX(b)).toBeLessThan(-400);

  // a もポータルから編集空間へ戻れる
  await standAt(a, [0, 0, -3]);
  await expect.poll(() => myX(a)).toBeLessThan(-400);
});
