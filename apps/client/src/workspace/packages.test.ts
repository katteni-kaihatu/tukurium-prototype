import {
  gunAndTargetSample,
  type PackageDependency,
  type PackageManifest,
  ProjectDoc,
} from "@tukurium/repo-model";
import { describe, expect, it, vi } from "vitest";
import type { PackageVersion } from "../net/api";
import { resolvePackages } from "./packages";
import { checkScripts } from "./problems";

const manifest: PackageManifest = {
  format: 1,
  exports: [
    {
      kind: "kokostate",
      id: "ks_health",
      path: "/States/Health.koko",
      definition: { id: "ks_health", name: "Health", fields: [] },
    },
  ],
};
const dep = (packageId: string, version = 1): PackageDependency => ({
  alias: packageId,
  packageId,
  version,
  contentHash: "h1",
});
const version = (packageId: string, v: number, contentHash = "h1"): PackageVersion => ({
  packageId,
  version: v,
  contentHash,
  manifest,
});

describe("resolvePackages（依存の中身を取り出す。ADR 0015）", () => {
  it("取り出せた版は覚えておき、二度目は取り出さない", async () => {
    const fetch = vi.fn(async (id: string, v: number) => version(id, v));
    const a = await resolvePackages([dep("w_cache_a")], fetch);
    const b = await resolvePackages([dep("w_cache_a")], fetch);
    expect(a.get("w_cache_a")?.status).toBe("ready");
    expect(b.get("w_cache_a")?.status).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("取り出せなかったら理由を残し、覚えずに次で取り出し直す", async () => {
    const fetch = vi
      .fn<(id: string, v: number) => Promise<PackageVersion>>()
      .mockRejectedValueOnce(new Error("このライブラリを使う許可がありません"))
      .mockImplementation(async (id, v) => version(id, v));
    const first = await resolvePackages([dep("w_fail")], fetch);
    expect(first.get("w_fail")).toMatchObject({
      status: "unavailable",
      message: "このライブラリを使う許可がありません",
    });
    const second = await resolvePackages([dep("w_fail")], fetch);
    expect(second.get("w_fail")?.status).toBe("ready");
  });

  it("content hash が lock と違えば使わない", async () => {
    const got = await resolvePackages([dep("w_hash")], async (id, v) => version(id, v, "other"));
    expect(got.get("w_hash")).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("足したときと違います"),
    });
  });
});

describe("checkScripts と依存", () => {
  it("@別名 の import を解決し、まだ再生で動かないことを注意にする（Query の誤検出はしない）", async () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    p.addDependency({ ...dep("w_check"), alias: "combat" });
    const id = p.addSystem(
      "UseLib",
      `import Health from "@combat/States/Health.koko";\nexport default system({ query: { with: [Health] }, update() {} });\n`,
    );
    const problems = await checkScripts(p, [id], async (deps) =>
      resolvePackages(deps, async (pid, v) => version(pid, v)),
    );
    expect(problems.map((d) => [d.code, d.severity])).toEqual([
      ["import-package-runtime-pending", "warning"],
    ]);
  });

  it("依存にない別名はエラーにする", async () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    const id = p.addSystem("UseLib", `import Health from "@nope/States/Health.koko";\n`);
    const problems = await checkScripts(p, [id]);
    expect(problems.map((d) => d.code)).toEqual(["import-package-unknown"]);
  });
});
