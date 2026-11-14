import type { FieldSchemas } from "@tukurium/eks";
import {
  type ExpandedSnapshot,
  expandPrefabForEdit,
  expandPrefabs,
  isPackageResourceId,
  PrefabExpansionCache,
  type ProjectDoc,
} from "@tukurium/repo-model";
import { useWorkspace } from "./store";

/** 開いているワークスペースの制作データ。パネルはワークスペースを受け取り終えてから表示する。 */
export function useProject(): ProjectDoc {
  const project = useWorkspace((s) => s.project);
  if (!project) throw new Error("ワークスペースが開かれていません");
  return project;
}

/** 制作データを編集できるか（Edit mode で、共同編集以上の権限がある） */
export function useCanEdit(): boolean {
  return useWorkspace(
    (s) =>
      s.mode === "edit" &&
      (s.role === "editor" || s.role === "admin") &&
      !isPackageResourceId(s.editingPrefab?.id ?? ""),
  );
}

interface Expanded {
  rev: number;
  schemas: FieldSchemas;
  snapshot: ExpandedSnapshot;
  cache: PrefabExpansionCache;
}
const expandedOf = new WeakMap<ProjectDoc, Expanded>();

/**
 * プレハブのインスタンスを中身に展開した制作データ（ADR 0076）。アウトプットの表示（空間・Hierarchy・Inspector）は、
 * これを読む。制作データが変わる（rev が進む）まで同じものを返し、変わっていないプレハブは作り直さない。
 * 中身は読むだけにする。
 */
export function expandedSnapshot(
  project: ProjectDoc,
  rev: number,
  schemas: FieldSchemas,
): ExpandedSnapshot {
  const had = expandedOf.get(project);
  if (had && had.rev === rev && had.schemas === schemas) return had.snapshot;
  const cache = had?.cache ?? new PrefabExpansionCache();
  const snapshot = expandPrefabs(project.snapshotWithPackages(schemas), {
    schemas: project.prefabFieldSchemas(schemas),
    kokostates: project.packageKokoStates(),
    cache,
  });
  expandedOf.set(project, { rev, schemas, snapshot, cache });
  return snapshot;
}

/** 開いているワークスペースの、プレハブを展開した制作データ */
export function useExpanded(): ExpandedSnapshot {
  const project = useProject();
  const rev = useWorkspace((s) => s.rev);
  const schemas = useWorkspace((s) => s.fieldSchemas);
  return expandedSnapshot(project, rev, schemas);
}

interface PrefabEditView {
  rev: number;
  schemas: FieldSchemas;
  prefab: string;
  snapshot: ExpandedSnapshot | null;
  cache: PrefabExpansionCache;
}
const prefabEditOf = new WeakMap<ProjectDoc, PrefabEditView>();

/**
 * プレハブを開いて直すときの、編集用の Entity の並び（ADR 0076。`expandPrefabForEdit`）。
 * プレハブの中の Entity は、そのままの ID。アウトプットを展開したものと同じ形で、`output` はプレハブの ID。
 * プレハブがなければ null。中身は読むだけにする。
 */
export function prefabEditSnapshot(
  project: ProjectDoc,
  prefab: string,
  rev: number,
  schemas: FieldSchemas,
): ExpandedSnapshot | null {
  const had = prefabEditOf.get(project);
  if (had && had.rev === rev && had.schemas === schemas && had.prefab === prefab)
    return had.snapshot;
  // 取っておく入れ物は、アウトプットの展開のものとは分ける（開くプレハブを変えたら、作り直す）
  const cache = had?.prefab === prefab ? had.cache : new PrefabExpansionCache();
  const snapshot = expandPrefabForEdit(expandedSnapshot(project, rev, schemas), prefab, {
    schemas: project.prefabFieldSchemas(schemas),
    kokostates: project.packageKokoStates(),
    cache,
  });
  prefabEditOf.set(project, { rev, schemas, prefab, snapshot, cache });
  return snapshot;
}

/**
 * いま編集しているもの（アウトプットか、開いているプレハブ）。Hierarchy と Inspector は、これを読む。
 * - prefabId：開いているプレハブ（アウトプットを編集しているときは null）
 * - ownerId：持ち主の ID（アウトプットの ID か、プレハブの ID）。snapshot の Entity の output は、これ
 * - snapshot：表示用の並び（インスタンスは、中身に展開してある）
 */
export function useEditTarget(): {
  prefabId: string | null;
  ownerId: string;
  snapshot: ExpandedSnapshot;
} {
  const project = useProject();
  const rev = useWorkspace((s) => s.rev);
  const schemas = useWorkspace((s) => s.fieldSchemas);
  const outputId = useWorkspace((s) => s.outputId);
  // 再生中は、アウトプットを見る（プレハブは、Play を始めるときに閉じる）
  const open = useWorkspace((s) => (s.mode === "edit" ? (s.editingPrefab?.id ?? null) : null));
  const view = open ? prefabEditSnapshot(project, open, rev, schemas) : null;
  if (open && view) return { prefabId: open, ownerId: open, snapshot: view };
  return { prefabId: null, ownerId: outputId, snapshot: expandedSnapshot(project, rev, schemas) };
}
