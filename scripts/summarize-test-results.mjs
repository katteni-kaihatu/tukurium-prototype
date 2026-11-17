// Vitest の JSON レポート（--reporter=json）を、CI のステップ要約に出す形に整える。
// 使い方: node scripts/summarize-test-results.mjs <jsonファイル> <ラベル>
// ファイル別の所要時間（テスト本体の合計）を重い順に出す。import や transform の時間は含まない。
import { existsSync, readFileSync } from "node:fs";

const [path, label] = process.argv.slice(2);
if (!path || !existsSync(path)) {
  console.log(`テスト結果の要約: ${label ?? ""} の JSON レポートがありませんでした`);
  process.exit(0);
}

// 要約は付随情報なので、壊れた JSON でジョブ自体を落とさない。
let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch {
  console.log(`テスト結果の要約: ${label ?? ""} の JSON レポートを読めませんでした`);
  process.exit(0);
}
const files = (report.testResults ?? [])
  .map((result) => {
    const totalMs = (result.assertionResults ?? []).reduce(
      (sum, assertion) => sum + (assertion.duration ?? 0),
      0,
    );
    return {
      name: result.name.replace(`${process.cwd()}/`, ""),
      tests: (result.assertionResults ?? []).length,
      seconds: totalMs / 1000,
    };
  })
  .sort((a, b) => b.seconds - a.seconds);

const totalSeconds = files.reduce((sum, file) => sum + file.seconds, 0);
console.log(`### テスト結果（${label ?? "all"}）`);
console.log("");
console.log(
  `${files.length} ファイル / ${report.numTotalTests ?? 0} 件、` +
    `成功 ${report.numPassedTests ?? 0}・失敗 ${report.numFailedTests ?? 0}、` +
    `テスト時間の合計 ${totalSeconds.toFixed(1)} 秒`,
);
console.log("");
console.log("| ファイル | 件数 | テスト時間 |");
console.log("| --- | ---: | ---: |");
for (const file of files.slice(0, 10)) {
  console.log(`| ${file.name} | ${file.tests} | ${file.seconds.toFixed(1)} 秒 |`);
}
