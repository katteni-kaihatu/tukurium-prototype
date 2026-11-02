export interface Config {
  host: string;
  port: number;
  /** 本番でクライアントのビルド結果を配信するディレクトリ。未設定なら配信しない。 */
  clientDir: string | undefined;
  /** PostgreSQL の接続先。未設定ならメモリに保存する（再起動で消える、開発用）。 */
  databaseUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 8787),
    clientDir: env.CLIENT_DIR || undefined,
    databaseUrl: env.DATABASE_URL || undefined,
  };
}
