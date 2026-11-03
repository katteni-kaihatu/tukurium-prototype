// 設置した環境の動作確認（スモークテスト）。
//   pnpm smoke https://tukurium.example.com
// ブラウザで開き、セッションを作ってサンプルのワークスペースを作り、再生できるかを確かめる。
// WebSocket（リバースプロキシの設定）・WASM（QuickJS・Rapier）・保存先がそろっていないと失敗する。
import { chromium } from "@playwright/test";

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const step = (msg) => console.log(`- ${msg}`);

const health = await fetch(`${base}/api/health`).catch((e) => ({
  ok: false,
  statusText: e.message,
}));
if (!health.ok) {
  console.error(`/api/health に届きません：${health.statusText}`);
  process.exit(1);
}
step(`health: ${JSON.stringify(await health.json())}`);

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => localStorage.setItem("tukurium.name", "smoke"));
  await page.goto(base);
  await page.getByRole("button", { name: "セッションを作って入る" }).click();
  await page.waitForURL(/\/s\/s_/, { timeout: 15_000 });
  step("セッションを作った（WebSocket OK）");
  await page.getByRole("button", { name: /サンプル「銃と的」で作る/ }).click();
  await page.locator('section[aria-label="Inspector"]').waitFor({ timeout: 15_000 });
  step("ワークスペースを作った（保存先・Git OK）");
  const main = page.locator('section[aria-label="ワークスペース"]');
  await main.getByRole("button", { name: /Play/ }).click();
  await main.getByText("Play mode").waitFor({ timeout: 20_000 });
  step("再生できた（QuickJS・Rapier の WASM OK）");
  await main.getByRole("button", { name: /Stop/ }).click();
} catch (e) {
  console.error(`失敗：${e instanceof Error ? e.message : e}`);
  if (errors.length) console.error(`ブラウザのエラー：\n${errors.join("\n")}`);
  await browser.close();
  process.exit(1);
}
await browser.close();
if (errors.length) console.warn(`ブラウザのエラー（参考）：\n${errors.join("\n")}`);
console.log("OK");
