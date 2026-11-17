// CI でテストを領域別に分ける定義（正本）。
// .github/workflows/ci.yml の test ジョブの matrix は、この定義と一致させること。
// 一致しているかと、分割でテストを取りこぼしていないかは、
// scripts/check-test-shards.mjs が CI の check ジョブで毎回確かめる。
//
// 分け方: --shard（ハッシュ順に件数均等）は重いファイルが同じ区間に寄って大きく偏ったため、
// 所要時間の実測（2026-11-17）がほぼ均等な領域別にした。
// 新しいパッケージを作ったら、どこかの filters に足す（足し忘れはチェックで落ちる）。
export const TEST_SHARDS = [
  { name: "server", filters: ["apps/server"] },
  { name: "runtime", filters: ["packages/runtime"] },
  {
    name: "rest",
    filters: [
      "apps/client",
      "packages/repo-model",
      "packages/typecheck",
      "packages/script",
      "packages/eks",
      "packages/shared",
    ],
  },
];
