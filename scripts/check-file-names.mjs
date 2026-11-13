// 大文字・小文字だけが違う名前のファイルがないか確かめる。
// Windows や macOS（大文字・小文字を区別しないファイルシステム）では、`./ProjectHome` の import が
// `ProjectHome.tsx` ではなく `projectHome.ts` に当たり、型・ビルド・開発サーバーが動かなくなる。
// Linux の CI では起きないので、ここで見つける。
import { execFileSync } from "node:child_process";

// ファイルシステムではなく Git の一覧を使う（区別しないファイルシステムでも、両方の名前が取れる）。
// まだコミットしていない新しいファイルも含める。
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
)
  .split("\0")
  .filter(Boolean);

// import は拡張子を書かないので、最後の拡張子を除いた名前で比べる。
const groups = new Map();
for (const file of files) {
  const slash = file.lastIndexOf("/");
  const dot = file.lastIndexOf(".");
  const stem = dot > slash + 1 ? file.slice(0, dot) : file;
  const key = stem.toLowerCase();
  if (!groups.has(key)) groups.set(key, new Map());
  const sameStem = groups.get(key);
  sameStem.set(stem, [...(sameStem.get(stem) ?? []), file]);
}

const collisions = [...groups.values()]
  .filter((sameStem) => sameStem.size > 1)
  .map((sameStem) => [...sameStem.values()].flat());

if (collisions.length > 0) {
  console.error(
    `大文字・小文字だけが違う名前のファイルがあります。片方の名前を変えてください:\n${collisions.map((group) => `  ${group.join(" / ")}`).join("\n")}`,
  );
  process.exit(1);
}
console.log("ファイル名の大文字・小文字: OK");
