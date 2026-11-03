import { checkProjectStructure, type Diagnostic, ResourcePathIndex } from "@tukurium/repo-model";
import { useEffect, useMemo } from "react";
import { checkScripts, mergeProblems, type Problem } from "./problems";
import { useWorkspace } from "./store";

/** 制作データが変わるたびに（少し待って）スクリプトを確かめ、「問題」を更新する */
export function useScriptCheck(): void {
  const project = useWorkspace((s) => s.project);
  const ready = useWorkspace((s) => s.ready);
  const rev = useWorkspace((s) => s.rev);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は制作データが変わった合図
  useEffect(() => {
    if (!project || !ready) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkScripts(project).then((checkProblems) => {
        if (!cancelled && useWorkspace.getState().project === project)
          useWorkspace.setState({ checkProblems });
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [project, ready, rev]);
}

/** いまの問題の一覧（実行して止まったもの → 編集中の確認の順） */
export function useProblems(): Problem[] {
  const run = useWorkspace((s) => s.runProblems);
  const check = useWorkspace((s) => s.checkProblems);
  return useMemo(() => mergeProblems(run, check), [run, check]);
}

/**
 * 制作データの構造の問題（名前の衝突・フォルダの輪など。ADR 0010）。
 * 各クライアントが同じ制作データから同じ結果を計算するので、保存も配信もしない。
 */
export function useStructureDiagnostics(): {
  diagnostics: Diagnostic[];
  index: ResourcePathIndex | null;
} {
  const project = useWorkspace((s) => s.project);
  const rev = useWorkspace((s) => s.rev);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は制作データが変わった合図
  return useMemo(() => {
    if (!project) return { diagnostics: [], index: null };
    const snap = project.snapshot();
    const index = ResourcePathIndex.fromSnapshot(snap);
    return { diagnostics: checkProjectStructure(snap, index), index };
  }, [project, rev]);
}
