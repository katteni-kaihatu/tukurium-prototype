import {
  checkProjectReferences,
  checkProjectStructure,
  type Diagnostic,
  type DiagnosticSummary,
  GenerationGate,
  ResourcePathIndex,
  summarizeDiagnostics,
  viewDiagnostics,
} from "@tukurium/repo-model";
import { useEffect, useMemo } from "react";
import { checkScripts, type Problem } from "./problems";
import { useWorkspace } from "./store";

/** 編集中の確認の世代（古い確認の結果が、後から届いて新しい結果を上書きしないように） */
const checkGate = new GenerationGate();

/** 制作データが変わるたびに（少し待って）スクリプトを確かめ、「問題」を更新する */
export function useScriptCheck(): void {
  const project = useWorkspace((s) => s.project);
  const ready = useWorkspace((s) => s.ready);
  const rev = useWorkspace((s) => s.rev);
  useEffect(() => {
    if (!project || !ready) return;
    // 確かめ終わるまでは、前の結果を stale（編集前の結果）として見せておく
    const timer = setTimeout(() => {
      const generation = checkGate.begin();
      void checkScripts(project).then((diagnostics) => {
        if (checkGate.accepts(generation) && useWorkspace.getState().project === project)
          useWorkspace.setState({ checkProblems: { diagnostics, observedVersion: rev } });
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [project, ready, rev]);
}

/** いまのスクリプトの問題の一覧（current → stale、実行して止まったもの → 編集中の確認の順） */
export function useProblems(): Problem[] {
  const run = useWorkspace((s) => s.runProblems);
  const check = useWorkspace((s) => s.checkProblems);
  const rev = useWorkspace((s) => s.rev);
  return useMemo(() => viewDiagnostics([run, check], rev), [run, check, rev]);
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
