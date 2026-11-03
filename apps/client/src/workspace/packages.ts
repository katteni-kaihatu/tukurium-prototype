import type { PackageDependency, PackageResolution } from "@tukurium/repo-model";
import { api, type PackageVersion } from "../net/api";

/**
 * 依存の中身（ライブラリの版の manifest）を取り出す（ADR 0015）。
 * 版の中身は変わらないので、取り出せたものは Package ID と版ごとに覚えておく。
 * 取り出せなかったもの（許可がない・通信の失敗）は覚えず、次の確認で取り出し直す。
 */
export type PackageFetcher = (packageId: string, version: number) => Promise<PackageVersion>;

const cache = new Map<string, PackageVersion>();

export async function resolvePackages(
  deps: readonly PackageDependency[],
  fetchVersion: PackageFetcher = api.packageVersion,
): Promise<Map<string, PackageResolution>> {
  const out = new Map<string, PackageResolution>();
  await Promise.all(
    deps.map(async (dep) => {
      const key = `${dep.packageId}@${dep.version}`;
      let got = cache.get(key);
      if (!got) {
        try {
          got = await fetchVersion(dep.packageId, dep.version);
          cache.set(key, got);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          out.set(dep.alias, { status: "unavailable", dependency: dep, message });
          return;
        }
      }
      if (got.contentHash !== dep.contentHash) {
        out.set(dep.alias, {
          status: "unavailable",
          dependency: dep,
          message: `v${dep.version} の中身が、足したときと違います`,
        });
        return;
      }
      out.set(dep.alias, { status: "ready", dependency: dep, manifest: got.manifest });
    }),
  );
  return out;
}
