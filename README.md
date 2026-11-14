# Tukurium プロトタイプ

ブラウザの 3D 空間で交流しながら、複数人でアイテムやワールドを制作する環境のプロトタイプ。

- 文書の案内：[docs/README.md](docs/README.md)
- できること：[docs/FEATURES.md](docs/FEATURES.md)
- ロードマップ：[docs/roadmap/](docs/roadmap/README.md)
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

クライアント（http://localhost:5173 ）とサーバー（http://localhost:8787 ）が起動する。クライアントの `/api` と `/ws` はサーバーへ中継される。

ログインは Misskey（misskey.resonite.love）でするが、手元では Misskey から戻れないので、ログインの画面の「開発用ログイン」に名前を入れて入る（`apps/server/dev.env` の `AUTH_DEV_LOGIN=1` で開く。本番では開かない。ADR 0074）。複数のブラウザ（またはシークレットウィンドウ）で別の名前で入ると、互いの位置が見える。

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
