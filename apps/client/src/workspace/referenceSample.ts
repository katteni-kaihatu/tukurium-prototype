import { OFFICIAL_COMBAT, referenceGunAndTarget } from "@tukurium/repo-model";
import { api } from "../net/api";
import { useWorkspace } from "./store";

/**
 * reference UGC「銃と的（公式ライブラリ）」を作る（ADR 0016）。サーバーの公式 combat の最新の版を
 * 依存に固定（lock）してから作るので、作ったあとに公式の版が上がっても中身は変わらない。
 */
export async function createReferenceSample(): Promise<void> {
  const works = await api.works();
  const combat = works.find((w) => w.id === OFFICIAL_COMBAT.workId && w.official);
  if (!combat?.latest) throw new Error("公式ライブラリ「combat」が見つかりません");
  const pkg = await api.packageVersion(combat.id, combat.latest.version);
  const snapshot = referenceGunAndTarget({
    alias: OFFICIAL_COMBAT.alias,
    packageId: pkg.packageId,
    version: pkg.version,
    contentHash: pkg.contentHash,
  });
  useWorkspace.getState().create(snapshot.name, snapshot);
}
