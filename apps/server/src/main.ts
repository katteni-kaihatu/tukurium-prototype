import { buildApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = await buildApp(config);
await app.listen({ host: config.host, port: config.port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
}
