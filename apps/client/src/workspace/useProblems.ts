import {
  checkProjectReferences,
  checkProjectStructure,
  type Diagnostic,
  type DiagnosticSummary,
  ResourcePathIndex,
  summarizeDiagnostics,
  viewDiagnostics,
} from "@tukurium/repo-model";
import { useEffect, useMemo } from "react";
import { IncrementalCheck } from "./incrementalCheck";
import { checkScripts, type Problem } from "./problems";
import { useWorkspace } from "./store";

/** 制作データが変わるたびに、影響を受ける System だけを（少し待って）確かめ、「問題」を更新する */
export function useScriptCheck(): void {
  const project = useWorkspace((s) => s.project);
  const ready = useWorkspace((s) => s.ready);
  const rev = useWorkspace((s) => s.rev);
  const checker = useMemo(
    () => (project ? new IncrementalCheck((ids) => checkScripts(project, ids)) : null),
    [project],
  );
  useEffect(() => {
    if (!project || !ready || !checker) return;
    // 影響を受けない System の結果はすぐ今の版にする。受ける System は、確かめ終わるまで stale
    checker.update(project.snapshot(), rev);
    useWorkspace.setState({ checkProblems: checker.sets() });
    const timer = setTimeout(() => {
      void checker.check(rev).then((accepted) => {
        if (accepted && useWorkspace.getState().project === project)
          useWorkspace.setState({ checkProblems: checker.sets() });
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [project, ready, rev, checker]);
}

/** いまのスクリプトの問題の一覧（current → stale、実行して止まったもの → 編集中の確認の順） */
export function useProblems(): Problem[] {
  const run = useWorkspace((s) => s.runProblems);
  const check = useWorkspace((s) => s.checkProblems);
  const rev = useWorkspace((s) => s.rev);
  return useMemo(() => viewDiagnostics([run, ...check], rev), [run, check, rev]);
}

/**
 * 制作データの問題（構造・リソース参照。ADR 0010）と、リソースごとの件数。
 * 各クライアントが同じ制作データから同じ結果を計算するので、保存も配信もしない。
 */
export function useProjectDiagnostics(): {
  diagnostics: Diagnostic[];
  index: ResourcePathIndex | null;
  summary: Map<string, DiagnosticSummary>;
} {
  const project = useWorkspace((s) => s.project);
  const rev = useWorkspace((s) => s.rev);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は制作データが変わった合図
  return useMemo(() => {
    if (!project) return { diagnostics: [], index: null, summary: new Map() };
    const snap = project.snapshot();
    const index = ResourcePathIndex.fromSnapshot(snap);
    const diagnostics = [...checkProjectStructure(snap, index), ...checkProjectReferences(snap)];
    return { diagnostics, index, summary: summarizeDiagnostics(diagnostics, index) };
  }, [project, rev]);
}
