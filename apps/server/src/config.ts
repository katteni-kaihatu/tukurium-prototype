import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  /** 本番でクライアントのビルド結果を配信するディレクトリ。未設定なら配信しない。 */
  clientDir: string | undefined;
  /** PostgreSQL の接続先。未設定ならメモリに保存する（再起動で消える、開発用）。 */
  databaseUrl: string | undefined;
  /** S3 互換ストレージ（素材の置き場）。未設定ならディスク（assetDir）に置く */
  s3:
    | {
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
      }
    | undefined;
  assetDir: string;
  /** Git リポジトリの置き場 */
  gitDir: string;
  /** ログインに使う Misskey（ADR 0074） */
  misskeyUrl: string;
  /**
   * 開発用ログイン（名前だけで入れる）。AUTH_DEV_LOGIN=1 で、かつ NODE_ENV が production でないときだけ開く
   */
  devLogin: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 8787),
    // @fastify/static は絶対パスしか受け付けないので、相対パスはここで直す
    clientDir: env.CLIENT_DIR ? resolve(env.CLIENT_DIR) : undefined,
    databaseUrl: env.DATABASE_URL || undefined,
    s3: env.S3_ENDPOINT
      ? {
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION || "us-east-1",
          bucket: env.S3_BUCKET || "tukurium",
          accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
          secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
        }
      : undefined,
    assetDir: env.ASSET_DIR || "./data/assets",
    gitDir: env.GIT_DATA_DIR || "./data/git",
    misskeyUrl: env.MISSKEY_URL || "https://misskey.resonite.love",
    devLogin: env.AUTH_DEV_LOGIN === "1" && env.NODE_ENV !== "production",
  };
}
