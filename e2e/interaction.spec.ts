import { expect, type Page } from "@playwright/test";
import { createSessionAndWorkspace, test } from "./helpers";

// Resources のフォルダ、3D パネルの照準クリック・右ドラッグ、右クリックで持つ（Grabbable）

const panel = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);

/** 空間に入っている（ポインターロック中）状態にする。ヘッドレスではロックできないので、状態だけ真似る */
async function pretendLocked(page: Page) {
  await page.evaluate(() =>
    Object.defineProperty(
      (window as unknown as { __tukurium: any }).__tukurium.controller,
      "locked",
      { get: () => true, configurable: true },
    ),
  );
}

test("Resources：フォルダを作り、ドラッグで移し、中に入り、さがせる", async ({ page }) => {
  await createSessionAndWorkspace(page, "れにうむ", "sample");
  const res = panel(page, "Resources");

  await res.getByRole("button", { name: "New", exact: true }).click();
  await res.getByRole("menuitem", { name: /^フォルダ/ }).click();
  await res.getByLabel("フォルダの名前").fill("しくみ");
  await res.getByLabel("フォルダの名前").press("Enter");
  await expect(res.getByRole("button", { name: "しくみ（Folder）" })).toBeVisible();

  // ドラッグでフォルダへ移す
  await res
    .getByRole("button", { name: "Shoot（Script）" })
    .dragTo(res.getByRole("button", { name: "しくみ（Folder）" }));
  await expect(res.getByRole("button", { name: "Shoot（Script）" })).toHaveCount(0);

  // ダブルクリックで中に入る。場所の表示と木が変わる
  await res.getByRole("button", { name: "しくみ（Folder）" }).dblclick();
  await expect(res.getByRole("button", { name: "Shoot（Script）" })).toBeVisible();
  await expect(res.getByRole("navigation", { name: "場所" })).toContainText("しくみ");
  await expect(res.getByRole("treeitem", { name: "しくみ" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // いちばん上に戻って、さがすと中のフォルダのものも出る（一覧では場所つき）
  await res.getByRole("button", { name: "ひとつ上のフォルダへ" }).click();
  await res.getByRole("button", { name: "一覧" }).click();
  await res.getByLabel("このフォルダ内をさがす").fill("Shoot");
  await expect(res.getByRole("button", { name: "Shoot（Script）" })).toContainText("in しくみ");

  // 詳細表示では使われ方が出る
  await res.getByLabel("このフォルダ内をさがす").fill("");
  await res.getByRole("button", { name: "詳細" }).click();
  await expect(res.getByRole("button", { name: "Gun（KokoState）" })).toContainText("Entity 1");
});

test("3D パネル：照準でクリックでき、右ドラッグで動かせる", async ({ page }) => {
  await createSessionAndWorkspace(page, "れにうむ", "sample");
  const res = panel(page, "Resources");
  await res.getByRole("button", { name: /^ピン留め/ }).click();

  // 空間に入っていないとき：右ドラッグで画面の中央へ動かす
  const head = await res.locator("header").boundingBox();
  if (!head) throw new Error("見えていません");
  await page.mouse.move(head.x + 60, head.y + 15);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(720, 450, { steps: 8 });
  await page.mouse.up({ button: "right" });
  const box = await res.boundingBox();
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - 720)).toBeLessThan(10);

  // 空間に入っているとき：照準（画面の中央）の先のタイルがクリックで選べる
  await pretendLocked(page);
  const aimed = await page.evaluate(() => {
    const el = (window as unknown as { __tukurium: any }).__tukurium
      .aimedPanelElement()
      ?.closest("button[aria-pressed]");
    el?.setAttribute("data-e2e-aimed", "");
    return el?.getAttribute("aria-pressed") ?? null;
  });
  expect(aimed).toBe("false");
  await page.mouse.click(10, 300);
  await expect(res.locator("[data-e2e-aimed]")).toHaveAttribute("aria-pressed", "true");

  // 空間に入っているとき：右ドラッグで、向きに合わせてついてくる
  const before = await page.evaluate(
    () =>
      (window as unknown as { __tukurium: any }).__tukurium.panels.transformOf("ws-resources")
        .position[0],
  );
  await page.mouse.down({ button: "right" });
  await page.evaluate(() => {
    (window as unknown as { __tukurium: any }).__tukurium.controller.yaw += 0.4;
  });
  await page.waitForTimeout(300);
  await page.mouse.up({ button: "right" });
  const after = await page.evaluate(
    () =>
      (window as unknown as { __tukurium: any }).__tukurium.panels.transformOf("ws-resources")
        .position[0],
  );
  expect(after).toBeLessThan(before - 0.2);
});

test("右クリックで Grabbable を持ち、向きに合わせて動かし、もう一度で放す", async ({ page }) => {
  await createSessionAndWorkspace(page, "れにうむ", "sample");
  const insp = panel(page, "Inspector");
  await insp.getByRole("button", { name: "的1" }).click();
  await insp.getByRole("button", { name: "＋ Add KokoState" }).click();
  await insp.getByLabel("KokoState を検索").fill("Grabbable");
  await insp
    .getByRole("button", { name: /^Grabbable/ })
    .first()
    .click();
  const main = panel(page, "ワークスペース");
  await main.getByRole("button", { name: /Play/ }).click();
  await expect(main.getByText("Play mode")).toBeVisible();

  const target = () =>
    page.evaluate(() => {
      const rt = (window as unknown as { __workspace: any }).__workspace.getState().runtime();
      const id = rt.world.entityIds().find((x: string) => rt.nameOf(x) === "的1");
      return {
        held: rt.world.get(id, "builtin.Held")?.player ?? null,
        x: rt.world.get(id, "builtin.Transform").position[0] as number,
      };
    });
  // 的1 の 3m 手前に立って狙う
  await page.evaluate(() => {
    const rt = (window as unknown as { __workspace: any }).__workspace.getState().runtime();
    const id = rt.world.entityIds().find((x: string) => rt.nameOf(x) === "的1");
    const p = rt.world.get(id, "builtin.Transform").position;
    const c = (window as unknown as { __tukurium: any }).__tukurium.controller;
    c.position.set(p[0], 0, p[2] + 3);
    c.yaw = 0;
    c.pitch = Math.atan2(p[1] - 1.6, 3);
  });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  await pretendLocked(page);
  const start = await target();

  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await expect.poll(async () => (await target()).held).toBeTruthy();

  await page.evaluate(() => {
    (window as unknown as { __tukurium: any }).__tukurium.controller.yaw += 0.8;
  });
  await expect.poll(async () => (await target()).x).toBeLessThan(start.x - 0.3);

  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await expect.poll(async () => (await target()).held).toBeNull();
});
