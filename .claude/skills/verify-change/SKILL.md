---
name: verify-change
description: Tukurium の変更を確かめる手順。UI・3D・スクリプト・サーバーを変えたあと、PR を出す前、「動くか見て」と言われたときに使う。整形・lint・型・単体テスト・E2E・画面の確認（Playwright の使い捨てスクリプトとスクリーンショット）・本番ビルドのスモークテストまで。
---

# 変更を確かめる

## 1. いつも流すもの（速い順）

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test
```

`pnpm lint` は Biome に加えて、Dockerfile がすべての package.json を COPY しているかも検査する。

## 2. E2E

- 変えた所に近い spec だけ流す：`pnpm e2e e2e/<name>.spec.ts`
- PR の前には全部流す：`pnpm e2e`（4 分ほど）。開発サーバーが動いていればそれを使う。
- 新しく書くときの約束：
  - `test` は `e2e/helpers.ts` から import する
  - 2 人目以降の参加者は `newPerson(browser, name)` で開く
  - 長い手順の spec は `test.describe.configure({ timeout: 150_000 })`
- 落ちたら、まず `test-results/<テスト名>/error-context.md`（失敗時の画面の構造）を読む。1 本ずつなら通るのに通しで落ちるときは、負荷による時間切れを疑う（docs/DEVELOPMENT.md）。

## 3. 画面を見て確かめる（UI・3D パネル・見た目の変更）

E2E を書く前に、使い捨てのスクリプトで画面を開いてスクリーンショットを撮る。

1. 開発サーバーを裏で起動する：`pnpm dev`（ログはスクラッチのディレクトリへ）
2. スクリプトを `scripts/_scratch.mjs` に置く（`@playwright/test` を解決するため、リポジトリの中に置く）。終わったら消す。

```js
import { chromium } from "@playwright/test";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("ERR", e.message));
await page.addInitScript(() => localStorage.setItem("tukurium.name", "t"));
await page.goto("http://localhost:5173/");
await page.getByRole("button", { name: "セッションを作って入る" }).click();
await page.waitForURL(/\/s\/s_/);
await page.getByRole("button", { name: /サンプル「銃と的」で作る/ }).click();
await page.locator('section[aria-label="Inspector"]').waitFor();
// ここで操作する。開発ビルドでは window.__tukurium（エンジン）、__workspace、__sessionWorld、
// __app、__previews（ストア）を参照できる
await page.screenshot({ path: "<スクラッチ>/shot.png" });
await browser.close();
```

3. スクリーンショットを Read で見る。3D パネルのクリックを確かめるときは、`page.mouse.click()` で座標をクリックするか、`document.elementFromPoint()` でボタンの中心が本当にそのボタンに当たるかを調べる。

## 4. 本番ビルド（サーバー・ビルド・WASM に関わる変更）

```bash
pnpm build
```

```bash
CLIENT_DIR=apps/client/dist PORT=8799 GIT_DATA_DIR=$(mktemp -d) ASSET_DIR=$(mktemp -d) node apps/server/dist/main.js
```

別のシェルで：

```bash
pnpm smoke http://localhost:8799
```

終わったらサーバーを止める。

## 5. 報告

何を流して、何が通ったか（件数）を書く。流していないもの、落ちたものは、そのまま書く。
