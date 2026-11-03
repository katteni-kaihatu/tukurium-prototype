# 設置手順（VPS / Coolify）

docker compose の構成（`docker-compose.yml`）を、そのまま Coolify で動かす。

## 構成

| サービス | 内容 | 保存するもの |
| --- | --- | --- |
| `app` | クライアント（静的ファイル）とサーバー（HTTP・WebSocket）。ポート 8787 | `git-data`（リポジトリの Git）、`asset-data`（S3 を使わないときの素材） |
| `postgres` | PostgreSQL 17 | `pg-data`（利用者、ワークスペースの内容、リポジトリの情報、作品、リリース。セッションは保存しない） |

素材は S3 互換ストレージに置く。S3 の設定がなければ `asset-data` ボリュームに置く。

## Coolify での設定

1. 「New Resource」→「Docker Compose」で、このリポジトリの `main` ブランチを選ぶ。Compose ファイルは `docker-compose.yml`。
2. 環境変数を設定する（値の例は `.env.example`）。

   | 変数 | 必須 | 内容 |
   | --- | --- | --- |
   | `POSTGRES_PASSWORD` | ○ | PostgreSQL のパスワード（app と postgres の両方に使われる） |
   | `S3_ENDPOINT` | | S3 互換ストレージの URL。空ならボリュームに置く |
   | `S3_REGION` | | 既定 `us-east-1` |
   | `S3_BUCKET` | | 既定 `tukurium`。先に作っておく |
   | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | | S3 の認証情報 |
   | `APP_PORT` | | ホスト側に出すポート（既定 8787）。Coolify のプロキシを使うなら不要 |

3. ドメインを `app` サービスのポート 8787 に割り当てる。Coolify のプロキシ（Traefik / Caddy）は WebSocket（`/ws`）をそのまま通すので、追加の設定はいらない。
4. デプロイする。`app` はヘルスチェック（`/api/health`）が通ると healthy になる。

## 設置後の確認（スモークテスト）

手元から、設置した URL に対して実行する。ブラウザでセッションを作り、サンプルのワークスペースを作って再生できるかを確かめる。

```bash
pnpm smoke https://tukurium.example.com
```

失敗したときの見当：

| 止まった所 | 疑う所 |
| --- | --- |
| `/api/health に届きません` | ドメインの割り当て、`app` が起動しているか |
| セッションを作れない | WebSocket がプロキシで止められていないか |
| ワークスペースを作れない | PostgreSQL の接続、`/data/git` に書けるか |
| 再生できない | ブラウザのエラー（WASM の読み込み）。`pnpm smoke` がエラーの内容を表示する |

## 更新

`main` にマージしたら Coolify で再デプロイする（Webhook の自動デプロイを使ってもよい）。データはボリュームに残る。
接続中の人は切断され、自動で再接続する。再接続すると、ワークスペースの内容はサーバーに保存された分から戻る。セッション（参加者・配置・実行状態）はメモリにあるため、再起動で消える。

## バックアップ

- PostgreSQL：`docker compose exec postgres pg_dump -U tukurium tukurium > backup.sql`
- Git：`git-data` ボリューム（`/data/git`）をまるごと保存する
- 素材：S3 側のバケット、または `asset-data` ボリューム

## Docker Hub の取得制限

ビルドで `node:22-bookworm-slim` の取得に失敗するときは、ミラーのイメージを指定する。

```bash
docker compose build --build-arg NODE_IMAGE=<ミラーの node:22-bookworm-slim>
```

## 注意

- 素材の URL には本人確認のトークンが付く（`?t=…`。ADR 0008）。プロキシのアクセスログにクエリを残さない設定にしておくとよい。
- 本人確認はブラウザに保存したトークンだけで行っている（アカウント登録はない）。ブラウザのデータを消すと別人になる。
