// サーバーを1ファイルにまとめる。
// このパッケージの dependencies に書いた npm パッケージだけを外部のまま残し（本番では node_modules から読む）、
// ワークスペースの TS パッケージ（@tukurium/*）とその依存はバンドルに取り込む。
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = new Set(
  Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith("@tukurium/")),
);

const packageName = (spec) => {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/main.js",
  sourcemap: true,
  plugins: [
    {
      name: "externalize-own-deps",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("node:")) return { path: args.path, external: true };
          return external.has(packageName(args.path))
            ? { path: args.path, external: true }
            : undefined;
        });
      },
    },
  ],
});
