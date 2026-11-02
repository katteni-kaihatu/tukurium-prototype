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

サーバーの保存先（PostgreSQL）や、M3 以降の素材の置き場（S3 互換）を手元で使うときは、開発用の compose で起動する（Docker が必要）。

```bash
pnpm services:up
```

PostgreSQL（`localhost:5432`）と S3 互換ストレージの SeaweedFS（`localhost:8333`）が起動する。接続先は `.env.development.example` を参照し、`apps/server/.env` にコピーするとサーバーが使う（`DATABASE_URL` がなければメモリに保存し、再起動で消える）。止めるときは `pnpm services:down`。

## いまできること（M2 まで）

- ホームでセッションを作る・開いているセッションに参加する（URL を共有すれば同じセッションに入れる）。持ち主が閉じるとセッションはなくなる
- 3D 空間を FPS 視点で歩く。他の参加者の位置と、その人が開いているパネル（権限に応じた要約）が見える
- セッションの中でワークスペースを作り、複数人で同時に編集する（コードのカーソル共有を含む）。作業内容はサーバーに自動保存
- 権限：閲覧・共同編集・管理。参加者の初期値は管理者が設定（既定は共同編集、非公開も可）
- 再生はホスト（管理者）が実行して全員に共有。ホストが抜けたら別の管理者が引き継ぐ
- 独自の KokoState、JavaScript の System（`onUpdate` / `onInput` / `onEvent` / `onCollision`）、プロシージャル形状・マテリアル
- 同梱サンプル「銃と的」

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
