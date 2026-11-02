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

## 構成

```
apps/client      Vite + React + Three.js（3D 空間、パネル、Web ページ）
apps/server      Node.js（Fastify + WebSocket）
packages/shared  型と通信プロトコル（zod）
packages/eks     EKS コア（Entity / KokoState / Query / System の実行順）
packages/script  利用者スクリプトのサンドボックス（QuickJS）
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
