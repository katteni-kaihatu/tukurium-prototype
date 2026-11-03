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

Markdown、`docs/`、`.claude/`だけの変更はCIでも省略される。コード、依存関係、ビルド・実行・E2E設定に触れた場合は省略しない。

## 2. E2E（背骨の 4 本だけ）

- `pnpm e2e`（2 分ほど）。背骨の流れ（作る・一緒に編集・セッションに出して適用・公開）に触れたときに流す。
- PR の CI では実行しない。`main` へのマージ後・毎日の定期実行・手動実行で結果と失敗ログを確認する。
- `main` の E2E が落ちても後続 PR は止めない。テスト名と失敗箇所を残課題へ記録し、確認・修正を別の作業にする。
- 機能ごとの細かい E2E は足さない。新しい画面や操作は 3 の方法で確かめる。
- 背骨の流れを変えて E2E が落ちたら、直すのは E2E の方でよいかをまず考える。
- 落ちたら、まず `test-results/<テスト名>/error-context.md`（失敗時の画面の構造）を読む。

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
