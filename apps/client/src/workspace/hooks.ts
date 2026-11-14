import type { FieldSchemas } from "@tukurium/eks";
import {
  type ExpandedSnapshot,
  expandPrefabs,
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
  return useWorkspace((s) => s.mode === "edit" && (s.role === "editor" || s.role === "admin"));
}

interface Expanded {
  rev: number;
  schemas: FieldSchemas;
  snapshot: ExpandedSnapshot;
  cache: PrefabExpansionCache;
}
const expandedOf = new WeakMap<ProjectDoc, Expanded>();

/**
 * プレハブのインスタンスを中身に展開した制作データ（ADR 0076）。表示（空間・Hierarchy・Inspector）は、
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
  const snapshot = expandPrefabs(project.snapshot(), {
    schemas,
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
