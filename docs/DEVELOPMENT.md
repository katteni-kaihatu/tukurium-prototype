# 開発メモ：詰まりやすい点

開発中に実際に時間を取られた点を、原因と対策つきでまとめる。新しく詰まったら書き足す。

## E2E（Playwright）

| 症状 | 原因 | 対策 |
| --- | --- | --- |
| 通しで流すと後半のテストが時間切れで落ちる。1 本ずつなら通る | 2 人目以降のブラウザコンテキストを閉じておらず、前のテストの画面が描画（ソフトウェア WebGL）を続けていた | `e2e/helpers.ts` の `test` と `newPerson()` を使う。テストの終わりに自動で閉じる（Biome で強制）。通しの実行時間は 8.7 分から 2.9 分に短くなった |
| 依存を足した直後の初回だけ失敗する | Vite が依存を最適化し直してページを再読み込みする | もう一度流す。CI ではビルド済みの状態で流す |
| 向きを変えた直後のレイキャストが外れる | カメラの向きは描画のフレームで反映される | `aimAt()` は 2 フレーム待つ。自前で向きを変えたら `requestAnimationFrame` を 2 回待つ |
| 撃ったのに弾が減らない | 銃のクールダウン（0.2 秒） | 撃つ間隔をあける（`fire()` は 150ms 待つ） |
| `getByText` / `getByRole` が複数に当たる | 「銃」「銃と的」などの部分一致 | `exact: true` か、名前の正規表現を詳しくする |
| 失敗の原因が分からない | — | `test-results/<テスト名>/error-context.md` に、失敗時の画面の構造（アクセシビリティツリー）が残る。まずそれを読む |
| ポインターロック中はクリックがパネルに届かない | ヘッドレスではポインターロックが不安定 | 入力は `__workspace.getState().input(...)` などで直接渡す。パネルのクリックを確かめるときは `page.mouse.click()` で座標をクリックする |

## 3D パネル（CSS3DRenderer）

- **同じ場所に重ねて置くと、後ろのパネルがクリックを受け取れない。** 3D にするとき、画面上でいまある位置に、同じ大きさで見える奥行きに置く（`PanelLayer.tsx` の `placeInFront`）。
- **カメラの後ろにある CSS3D 要素は、画面いっぱいに広がってクリックを奪うことがある。** 毎フレーム後ろのパネルを隠す（`PanelSpace.update`）。裏から見たときも `backface-visibility: hidden` で隠す。
- 3D のパネルを操作しづらくなったときの逃げ道として、画面左下に「空間のパネル」の一覧（画面に戻す）を出している。
- 確かめるときは `document.elementFromPoint()` で、ボタンの中心が本当にそのボタンに当たるかを調べる。

## スクリプト（QuickJS）

- QuickJS のハンドルは必ず dispose する。dispose 済みのハンドルに触ると落ちる（`alive` を確かめる）。
- QuickJS のメモリ上限は、配列などの確保では効かないことがある。WASM のヒープを見て、超えたらサンドボックスを `broken` にする（ADR 0001）。
- 初回の読み込みは VM の準備で遅いので、実行用とは別に読み込み用の時間制限（既定 1 秒）がある。
- エラーの行番号は、スタックの `<領域>/<System ID>.js:<行>` から取る（`lineInStack`）。
- 1 ステップの重さの大半は、Entity の値を JSON にして VM に渡す部分。計測は `pnpm bench:sim`。

## 物理（Rapier）

- Collider は、物理を 1 回進めるまでレイキャストに当たらない。そのため各ステップでは物理を先に進めてから、入力とスクリプトを処理する。

## サーバー・ビルド・デプロイ

| 症状 | 原因 | 対策 |
| --- | --- | --- |
| 本番で `Cannot find package 'zod'` | バンドルの外に出した依存が、本番の node_modules に入っていない | サーバーが使うものは `apps/server/package.json` の dependencies に書く（`build.mjs` はそれだけを外部扱いにする） |
| Docker ビルドで pnpm install が失敗する | 新しいパッケージの package.json を COPY していない | Dockerfile に COPY を足す（`pnpm lint` が検査する） |
| `CLIENT_DIR` を相対パスで渡すと起動しない | @fastify/static は絶対パスしか受け付けない | `config.ts` で絶対パスに直すようにした |
| Coolify でイメージを取得できない | MinIO の公式イメージの配布が止まった・Docker Hub の取得制限 | 本番の compose には S3 互換ストレージを含めない（外部を使う）。ベースイメージは `NODE_IMAGE` で差し替えられる |
| クラウドの開発環境で Docker ビルドが TLS で失敗する | 外向きの通信が、独自 CA のプロキシを通る | 一時的な Dockerfile で CA（`/root/.ccr/ca-bundle.crt`）を入れて確かめる。リポジトリには入れない |

## React・UI

- フックを早期 return の後で呼ぶと、表示が切り替わったときに落ちる。Biome の `useHookAtTopLevel` で検出する。
- パネルを重ねたとき、触ったパネルを前に出す（pointerdown で z-index を上げる）。

## GitHub・CI

- `.github/workflows/ci.yml` で、lint・型・単体テスト・ビルド・E2E を流す。CI がない間は、手元で全部流してからマージしていた。
