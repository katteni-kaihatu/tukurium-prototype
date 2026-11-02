# Tukurium プロトタイプ

ブラウザの 3D 空間で交流しながら、複数人でアイテムやワールドを制作する環境のプロトタイプ。

- 要件：[docs/requirements-v0.1.md](docs/requirements-v0.1.md)
- 実装計画・ロードマップ：[docs/PLAN.md](docs/PLAN.md)
- 決定記録：[docs/adr/](docs/adr/)

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
| `pnpm e2e` | ブラウザでの通しテスト（Playwright。開発サーバーを自動で起動） |

### 周辺サービス（PostgreSQL・S3 互換ストレージ）

M2 以降でサーバーが DB とストレージを使うようになったら、開発用の compose で起動する（Docker が必要）。

```bash
pnpm services:up
```

PostgreSQL（`localhost:5432`）と S3 互換ストレージの SeaweedFS（`localhost:8333`）が起動する。接続先は `.env.development.example` を参照。止めるときは `pnpm services:down`。

## いまできること（M1 まで）

- 3D 空間を FPS 視点で歩く。他の参加者の位置が見える
- ワークスペースのパネル（ワークスペース・Inspector・Resources・コード）。ピンで「画面に固定」と「空間に置く」を切り替えられる
- 独自の KokoState（フィールドと初期値）を作り、Entity に付ける。プロシージャル形状・マテリアル
- JavaScript で System を書く（Query の With / Without、`onUpdate` / `onInput` / `onEvent` / `onCollision`）
- Play / Pause / Stop。クリックで `fire`、R で `reload`、E で `use` を入力として渡す
- 同梱サンプル「銃と的」（ワークスペースパネルの「ログ・保存」から読み込み直せる）

制作データはまだブラウザの中に保存される（共同編集・サーバー保存は M2）。

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

```bash
docker compose up -d --build
```

`app`（クライアント＋サーバー）と `postgres` が起動する。S3 互換ストレージは外部のものを環境変数で指定する（設定値は `.env.example` を参照）。

Docker Hub の取得制限に当たる場合は、ベースイメージを差し替えられる：

```bash
docker compose build --build-arg NODE_IMAGE=<ミラーの node:22-bookworm-slim>
```
