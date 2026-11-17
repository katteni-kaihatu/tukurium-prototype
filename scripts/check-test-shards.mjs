// テストの領域別分割（scripts/test-shards.mjs）が、全テストファイルを
// 漏れなく・重なりなく覆っているかと、ci.yml の matrix が定義どおりかを確かめる。
// 分割の取りこぼしは「誰も実行しないテスト」が静かに生まれる事故なので、
// ここで落として気づけるようにする。CI の check ジョブから実行する。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { TEST_SHARDS } from "./test-shards.mjs";

const VITEST = "node_modules/.bin/vitest";

function listFiles(filters) {
  const out = execFileSync(VITEST, ["list", "--filesOnly", ...filters], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".test.ts"))
    .sort();
}

const problems = [];

const all = listFiles([]);
const assigned = new Map();
for (const shard of TEST_SHARDS) {
  const files = listFiles(shard.filters);
  if (files.length === 0) {
    problems.push(`シャード「${shard.name}」にファイルがありません`);
  }
  for (const file of files) {
    if (assigned.has(file)) {
      problems.push(
        `${file} がシャード「${assigned.get(file)}」と「${shard.name}」の両方に入っています`,
      );
    }
    assigned.set(file, shard.name);
  }
}
for (const file of all) {
  if (!assigned.has(file)) {
    problems.push(`${file} がどのシャードにも入っていません`);
  }
}

// ci.yml の matrix が定義とずれていたら、チェックが緑でも CI の実物は別物になる。
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
for (const shard of TEST_SHARDS) {
  if (!ci.includes(`name: ${shard.name}`)) {
    problems.push(`ci.yml の matrix にシャード「${shard.name}」がありません`);
  }
  const filtersText = shard.filters.join(" ");
  if (!ci.includes(`filters: "${filtersText}"`)) {
    problems.push(
      `ci.yml のシャード「${shard.name}」の filters が定義（${filtersText}）と違います`,
    );
  }
}

if (problems.length > 0) {
  console.error("テスト分割のチェックに失敗しました:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(
  `テスト分割 OK: 全${all.length}ファイルが ${TEST_SHARDS.length} シャードに漏れなく分かれています`,
);
