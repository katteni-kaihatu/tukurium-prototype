import {
  OFFICIAL_COMBAT,
  OFFICIAL_INTERACTION,
  OFFICIAL_ITEMS,
  type PackageDependency,
  type ProjectSnapshot,
  referenceDoorAndSwitch,
  referenceGunAndTarget,
  referenceKeyAndDoor,
} from "@tukurium/repo-model";
import { api } from "../net/api";
import { useWorkspace } from "./store";

/** reference UGC（ADR 0016）：使う公式ライブラリと、その lock から制作データを作る関数 */
const REFERENCES = {
  gunAndTarget: { library: OFFICIAL_COMBAT, build: referenceGunAndTarget },
  doorAndSwitch: { library: OFFICIAL_INTERACTION, build: referenceDoorAndSwitch },
  keyAndDoor: { library: OFFICIAL_ITEMS, build: referenceKeyAndDoor },
} satisfies Record<
  string,
  {
    library: { alias: string; workId: string };
    build: (dep: PackageDependency) => ProjectSnapshot;
  }
>;

/**
 * reference UGC のサンプルを作る。サーバーの公式ライブラリの最新の版を依存に固定（lock）してから作るので、
 * 作ったあとに公式の版が上がっても中身は変わらない。
 */
export async function createReferenceSample(kind: keyof typeof REFERENCES): Promise<void> {
  const { library, build } = REFERENCES[kind];
  const works = await api.works();
  const work = works.find((w) => w.id === library.workId && w.official);
  if (!work?.latest) throw new Error(`公式ライブラリ「${library.alias}」が見つかりません`);
  const pkg = await api.packageVersion(work.id, work.latest.version);
  const snapshot = build({
    alias: library.alias,
    packageId: pkg.packageId,
    version: pkg.version,
    contentHash: pkg.contentHash,
  });
  useWorkspace.getState().create(snapshot.name, snapshot);
}
