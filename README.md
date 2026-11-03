# Tukurium プロトタイプ

ブラウザの 3D 空間で交流しながら、複数人でアイテムやワールドを制作する環境のプロトタイプ。

- 要件：[docs/requirements-v0.1.md](docs/requirements-v0.1.md)
- 実装計画・ロードマップ：[docs/PLAN.md](docs/PLAN.md)
- 決定記録：[docs/adr/](docs/adr/)
- 開発メモ（詰まりやすい点）：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。開発の約束は [CLAUDE.md](CLAUDE.md)

## 必要なもの

- Node.js 22 以上
- pnpm 10（`corepack enable` で有効になる）

## 開発

```bash
pnpm install
```

```bash
pnpm dev
```

クライアント（http://localhost:5173 ）とサーバー（http://localhost:8787 ）が起動する。クライアントの `/api` と `/ws` はサーバーへ中継される。複数のブラウザ（またはシークレットウィンドウ）で開くと、互いの位置が見える。

| コマンド | 内容 |
| --- | --- |
| `pnpm test` | 単体テスト（Vitest） |
| `pnpm typecheck` | 型チェック |
| `pnpm lint` / `pnpm format` | Biome による検査・整形 |
| `pnpm build` | クライアントとサーバーのビルド |
| `pnpm e2e` | ブラウザでの通しテスト（Playwright。背骨の 4 本：一人で作って撃つ・2 人で編集・セッションに出して適用・3 人で一周） |
| `pnpm smoke <URL>` | 設置した環境の動作確認（セッション作成・ワークスペース作成・再生） |

### 周辺サービス（PostgreSQL・S3 互換ストレージ）

サーバーの保存先（PostgreSQL）や、M3 以降の素材の置き場（S3 互換）を手元で使うときは、開発用の compose で起動する（Docker が必要）。

```bash
pnpm services:up
```

PostgreSQL（`localhost:5432`）と S3 互換ストレージの SeaweedFS（`localhost:8333`）が起動する。接続先は `.env.development.example` を参照し、`apps/server/.env` にコピーするとサーバーが使う（`DATABASE_URL` がなければメモリに保存し、再起動で消える）。止めるときは `pnpm services:down`。

## いまできること（M6 まで）

- ホームでセッションを作る・開いているセッションに参加する（URL を共有すれば同じセッションに入れる）。持ち主が閉じるとセッションはなくなる
- 3D 空間を FPS 視点で歩く。他の参加者の位置と、その人が開いているパネル（権限に応じた要約）が見える
- セッションの中でワークスペースを作り、複数人で同時に編集する（コードのカーソル共有を含む）。作業内容はサーバーに自動保存
- 権限：閲覧・共同編集・管理。参加者の初期値は管理者が設定（既定は共同編集、非公開も可）
- ワークスペースの再生はホスト（管理者）が実行して全員に共有。ホストが抜けたら別の管理者が引き継ぐ
- アウトプットを「セッションに出す」と、セッションの世界に置かれ、みんなで遊べる。編集を続けて「適用」すると、リンク先がすべて更新される。「維持」マークを付けたフィールド（残弾など）は実行値を保つ。リセットも可
- 別々のワークスペース（リポジトリ）で作った銃と射撃場を、セッションで組み合わせられる
- 独自の KokoState、JavaScript の System（`onUpdate` / `onInput` / `onEvent` / `onCollision`、`audio.play`）、プロシージャル形状・マテリアル、GLB・画像・音声の素材
- プロジェクト（リポジトリ）：作成（テンプレートから）、メッセージ付きのコミットと履歴（一緒に編集した人は Co-author）、差分。1 プロジェクトにつきワークスペースは同時に 1 つ
- 作品として公開・リリース（v1, v2, …）と権限（利用・元データ閲覧・フォーク／抽出）。セッションの「ライブラリ」から作品を置ける
- フォーク、抽出（アウトプットやリソースを選んで、新しい／既存のプロジェクトへ。由来が残る）
- 非公開の作業：独立した空間で編集・再生する。権限のない人には境界と「作業中」だけが見え、中身は届かない。セッションには出せない
- 開いていないワークスペースの編集中の物も、閲覧できる人には見える（ホストが送り、サーバーが権限で見せ分ける）
- ワールドの編集：「＋ ワールドを追加」で独立した空間に移り、セッションの区画のポータルから出入りする。セッションに出すと原点に置かれる
- 素材の取得にも権限（上げた人、使っている制作データを閲覧できる人だけ）
- スクリプトの「問題」：構文の誤りなどは Play しなくても出る。実行して止まった System は Stop しても次の Play まで残る。行番号つきで、クリックするとコードのその行へ移る
- パネルを 3D にすると、画面で見えていた位置にそのまま置かれる。空間に入っている間も、照準の先のパネルをクリック・ホイールで操作できる。右ドラッグでパネルを動かせる。画面左下の「空間のパネル」から画面に戻せる
- 右クリックで、Built-in の Grabbable を付けた物を持つ・放す（Collider も必要。持っている物はほかの人にも見える）
- Resources はフォルダで整理できる（フォルダの木・場所の表示・さがす・アイコン／一覧／詳細の表示・ドラッグで移す）
- プロジェクト名の変更（ワークスペースのメインパネル、またはプロジェクトページの Settings。持ち主だけ）
- Web ページ：ホーム・プロジェクト・新規作成・プロフィール・探す
- 同梱サンプル「銃と的」「銃」「射撃場」

## 構成

```
apps/client      Vite + React + Three.js（3D 空間、パネル、Web ページ）
apps/server      Node.js（Fastify + WebSocket）
packages/shared      型と通信プロトコル（zod）
packages/eks         EKS コア（Entity / KokoState / Query / System の実行順）
packages/script      利用者スクリプトのサンドボックス（QuickJS）
packages/repo-model  制作データ（Y.Doc 上の KokoState 定義・System・Entity・アウトプット）と同梱サンプル
packages/runtime     実行（EKS + 物理 Rapier + スクリプト）。入力・衝突・イベント・レイキャスト
e2e/                 Playwright の通しテスト
docker/          Dockerfile
```

## デプロイ（Coolify / docker compose）

手順・環境変数・バックアップ・確認方法は [docs/DEPLOY.md](docs/DEPLOY.md) を参照。

```bash
docker compose up -d --build
```

`app`（クライアント＋サーバー）と `postgres` が起動する。S3 互換ストレージは外部のものを環境変数で指定する（設定値は `.env.example` を参照）。

Docker Hub の取得制限に当たる場合は、ベースイメージを差し替えられる：

```bash
docker compose build --build-arg NODE_IMAGE=<ミラーの node:22-bookworm-slim>
```
