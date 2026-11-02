import type { ProjectDoc } from "@tukurium/repo-model";
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
