import { type FileMap, fromFiles, type ProjectSnapshot } from "@tukurium/repo-model";
import { useCanEdit, useProject } from "./hooks";
import { planRevert } from "./revert";
import { useSavedFiles } from "./useSavedFiles";

const snapshots = new WeakMap<FileMap, ProjectSnapshot>();

/** 最後に保存した形（ファイルから読んだもの）。同じファイルなら作り直さない */
export function savedSnapshot(files: FileMap): ProjectSnapshot {
  let snap = snapshots.get(files);
  if (!snap) {
    snap = fromFiles(files);
    snapshots.set(files, snap);
  }
  return snap;
}

/**
 * 差分を、最後に保存した形に戻す。編集できないとき・保存がまだ読めていないときは戻せない。
 * revert は、戻せなかったときにその理由を返す。
 */
export function useRevert() {
  const project = useProject();
  const files = useSavedFiles();
  const canEdit = useCanEdit();
  const head = files ? savedSnapshot(files) : null;
  const plan = (entryId: string, part?: string) =>
    canEdit && head ? planRevert(project, head, entryId, part) : null;
  return {
    head,
    canRevert: (entryId: string, part?: string) => plan(entryId, part) !== null,
    revert: (entryId: string, part?: string): string | null => {
      const run = plan(entryId, part);
      if (!run) return "元に戻せません";
      try {
        run();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  };
}
