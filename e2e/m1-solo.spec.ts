import { expect, type Locator, type Page, test } from "@playwright/test";
import { aimAt, createSessionAndWorkspace, fire, runtimeState } from "./helpers";

// M1 の完了条件：一人で、独自の KokoState と System を作り、Play で撃って当てられる（シナリオ 4）

const SHOOT = `export default system({
  query: { with: ["Gun"] },
  onInput(e, ev) {
    if (ev.action !== "fire" || ev.phase !== "down" || e.Gun.ammo <= 0) return;
    e.Gun.ammo -= 1;
    const hit = world.raycast(ev.origin, ev.direction, 100);
    if (hit) world.emit(hit.entity, "hit", {});
  },
});
`;

const TARGET = `export default system({
  query: { with: ["Target"] },
  onEvent(e, ev) {
    if (ev.name === "hit") {
      e.Target.hp -= 1;
      log("hit", e.Target.hp);
    }
  },
});
`;

const panel = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);

async function commitInput(input: Locator, value: string) {
  await input.fill(value);
  await input.press("Enter");
}

async function newKokoState(page: Page, name: string, field: string, def: string) {
  const res = panel(page, "Resources");
  await res.getByRole("button", { name: "＋ New" }).click();
  await res.getByRole("button", { name: /^KokoState/ }).click();
  const insp = panel(page, "Inspector");
  await commitInput(insp.getByLabel("Name"), name);
  await insp.getByRole("button", { name: "＋ Add field" }).click();
  await commitInput(insp.getByLabel("フィールド名"), field);
  await commitInput(insp.getByLabel("初期値"), def);
}

async function newScript(page: Page, code: string) {
  const res = panel(page, "Resources");
  await res.getByRole("button", { name: "＋ New" }).click();
  await res.getByRole("button", { name: /^Script/ }).click();
  const editor = panel(page, "コード").locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(code);
}

async function addKoko(page: Page, name: string) {
  const insp = panel(page, "Inspector");
  await insp.getByRole("button", { name: "＋ Add KokoState" }).click();
  await insp.getByLabel("KokoState を検索").fill(name);
  await insp
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .first()
    .click();
}

test("空のプロジェクトから銃と的を作り、Play で撃って当てる", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await createSessionAndWorkspace(page, "れにうむ", "empty");
  const main = panel(page, "ワークスペース");

  // 独自の KokoState
  await newKokoState(page, "Gun", "ammo", "5");
  await newKokoState(page, "Target", "hp", "2");

  // 的：ボックスに Collider と Target
  const insp = panel(page, "Inspector");
  await insp.getByRole("button", { name: "Entity を追加" }).click();
  await insp.getByRole("button", { name: "ボックス" }).click();
  await commitInput(insp.getByLabel("Name"), "的");
  await commitInput(insp.getByLabel("position X"), "0");
  await commitInput(insp.getByLabel("position Y"), "1.5");
  await commitInput(insp.getByLabel("position Z"), "-4");
  await addKoko(page, "Collider");
  await addKoko(page, "Target");

  // 銃：空の Entity に Gun
  await insp.getByRole("button", { name: "Entity を追加" }).click();
  await insp.getByRole("button", { name: "空の Entity" }).click();
  await commitInput(insp.getByLabel("Name"), "銃");
  await addKoko(page, "Gun");

  // System を書いてアウトプットに入れる
  await newScript(page, SHOOT);
  await newScript(page, TARGET);
  await insp.getByRole("button", { name: /新しいワークスペース/ }).click();
  const add = insp.getByLabel("System を追加");
  await add.selectOption({ label: "NewSystem1" });
  await add.selectOption({ label: "NewSystem2" });
  await expect(insp.getByText("2 有効")).toBeVisible();

  // Play して撃つ
  await main.getByRole("button", { name: /Play/ }).click();
  await expect(main.getByText("Play mode")).toBeVisible();
  await aimAt(page, [0, 1.5, -4]);
  await fire(page);
  await expect.poll(() => runtimeState(page, "的", "Target")).toEqual({ hp: 1 });
  await expect.poll(() => runtimeState(page, "銃", "Gun")).toEqual({ ammo: 4 });
  await expect(main.locator("li", { hasText: "hit 1" })).toHaveCount(1);

  // 外すと当たらない
  await aimAt(page, [0, 10, -4]);
  await fire(page);
  await expect.poll(() => runtimeState(page, "銃", "Gun")).toEqual({ ammo: 3 });
  expect(await runtimeState(page, "的", "Target")).toEqual({ hp: 1 });

  // Stop すると制作データ（hp: 2）に戻る
  await main.getByRole("button", { name: /Stop/ }).click();
  await insp.getByRole("button", { name: "的" }).click();
  await expect(insp.getByLabel("hp", { exact: true })).toHaveValue("2");
});
