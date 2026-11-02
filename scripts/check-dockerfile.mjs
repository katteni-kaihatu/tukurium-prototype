// Dockerfile がワークスペースのすべての package.json をコピーしているか確かめる。
// 足りないと `pnpm install --frozen-lockfile` がイメージのビルド中に失敗する。
import { existsSync, readdirSync, readFileSync } from "node:fs";

const dockerfile = readFileSync("docker/Dockerfile", "utf8");
const missing = [];
for (const dir of ["apps", "packages"]) {
  for (const name of readdirSync(dir)) {
    const pkg = `${dir}/${name}/package.json`;
    if (existsSync(pkg) && !dockerfile.includes(`COPY ${pkg} `)) missing.push(pkg);
  }
}
if (missing.length > 0) {
  console.error(
    `docker/Dockerfile に次の COPY がありません:\n${missing.map((p) => `  COPY ${p} ${p.replace("package.json", "")}`).join("\n")}`,
  );
  process.exit(1);
}
console.log("docker/Dockerfile: OK");
