export interface Config {
  host: string;
  port: number;
  /** 本番でクライアントのビルド結果を配信するディレクトリ。未設定なら配信しない。 */
  clientDir: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 8787),
    clientDir: env.CLIENT_DIR || undefined,
  };
}
