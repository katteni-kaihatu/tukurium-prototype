import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      // ヘッドレスでも WebGL を使う
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173/api/health",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
