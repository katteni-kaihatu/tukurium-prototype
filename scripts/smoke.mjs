// 設置した環境の動作確認（スモークテスト）。
//   pnpm smoke https://tukurium.example.com
// ブラウザで開き、セッションを作ってサンプルのワークスペースを作り、再生できるかを確かめる。
// WebSocket（リバースプロキシの設定）・WASM（QuickJS・Rapier）・保存先がそろっていないと失敗する。
// 入るには開発用ログイン（AUTH_DEV_LOGIN=1、NODE_ENV が production でないとき）を使う。
// 開発用ログインが閉じている本番では、ログインの画面が出ることと、ログインしていない接続を断ることだけを確かめる。
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
const healthBody = await health.json();
step(`health: ${JSON.stringify(healthBody)}`);
const auth = await (await fetch(`${base}/api/auth/me`)).json();
step(`ログイン: Misskey ${auth.misskeyHost}・開発用ログイン ${auth.devLogin ? "あり" : "なし"}`);

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  if (!auth.devLogin) {
    await page.goto(base);
    await page.getByRole("button", { name: "Misskey でログイン" }).waitFor({ timeout: 15_000 });
    step("ログインの画面が出た");
    const refused = await page.evaluate(
      ([url, protocol]) =>
        new Promise((resolve) => {
          const ws = new WebSocket(url);
          ws.onopen = () => ws.send(JSON.stringify({ t: "hello", protocol }));
          ws.onmessage = (ev) => resolve(String(ev.data));
          ws.onclose = () => resolve("closed");
          setTimeout(() => resolve("timeout"), 10_000);
        }),
      [`${base.replace(/^http/, "ws")}/ws`, healthBody.protocol],
    );
    if (!String(refused).includes("auth.required"))
      throw new Error(`WebSocket の応えが違います: ${refused}`);
    step(`ログインしていない接続を断った（WebSocket OK）: ${refused}`);
    await browser.close();
    console.log("OK（開発用ログインが閉じているので、ここまで）");
    process.exit(0);
  }
  const login = await page.request.post(`${base}/api/auth/dev`, {
    data: { name: "smoke" },
    headers: { origin: base },
  });
  if (!login.ok()) throw new Error(`開発用ログインに失敗しました（${login.status()}）`);
  await page.goto(base);
  await page.getByRole("button", { name: "セッションを作って入る" }).click();
  await page.waitForURL(/\/s\/s_/, { timeout: 15_000 });
  step("セッションを作った（WebSocket OK）");
  await page.getByRole("button", { name: "ワークスペース", exact: true }).click();
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
