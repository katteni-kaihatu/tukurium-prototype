import {
  belongsToDependency,
  checkFieldValues,
  checkPackageVersions,
  checkProjectReferences,
  checkProjectStructure,
  countCurrent,
  type Diagnostic,
  type DiagnosticSummary,
  type DiagnosticView,
  ProjectDependencyGraph,
  type ProjectDoc,
  packageKokoStates,
  type QueryItem,
  ResourcePathIndex,
  reachablePackages,
  readSystemQuery,
  summarizeDiagnostics,
  summarizeHierarchy,
  viewDiagnostics,
} from "@tukurium/repo-model";
import { hostApiDeclarations } from "@tukurium/runtime";
import { useEffect, useMemo, useRef } from "react";
import { IncrementalCheck } from "./incrementalCheck";
import { resolvePackagePool, resolvePackages } from "./packages";
import { checkScripts, type Problem, runSetsByChanges, trackErrorPrints } from "./problems";
import { useWorkspace } from "./store";
import { setEditorTypecheck, TypecheckClient } from "./typecheckClient";

/** Host API の宣言（型を確かめるときに Worker へ渡す） */
const HOST_DECLARATIONS = hostApiDeclarations();

/** 制作データが変わるたびに、影響を受ける System だけを（少し待って）確かめ、「問題」を更新する */
export function useScriptCheck(): void {
  const project = useWorkspace((s) => s.project);
  const ready = useWorkspace((s) => s.ready);
  const rev = useWorkspace((s) => s.rev);
  const checker = useMemo(
    () => (project ? new IncrementalCheck((ids) => checkScripts(project, ids)) : null),
    [project],
  );
  const recheckSeq = useWorkspace((s) => s.recheckSeq);
  const lastRecheck = useRef(recheckSeq);
  useEffect(() => {
    if (!project || !ready || !checker) return;
    // 影響を受けない System の結果はすぐ今の版にする。受ける System は、確かめ終わるまで stale
    checker.update(project.snapshot(), rev);
    // 「確かめ直す」が押されたら、すべての System を調べ直す
    const forced = lastRecheck.current !== recheckSeq;
    lastRecheck.current = recheckSeq;
    if (forced) checker.markAll();
    useWorkspace.setState({ checkProblems: checker.sets() });
    const timer = setTimeout(
      () => {
        if (!checker.hasPending()) return;
        useWorkspace.setState({ checking: true });
        void checker.check(rev).then((accepted) => {
          if (useWorkspace.getState().project !== project) return;
          useWorkspace.setState(
            accepted ? { checkProblems: checker.sets(), checking: false } : { checking: false },
          );
        });
      },
      forced ? 0 : 400,
    );
    return () => clearTimeout(timer);
  }, [project, ready, rev, checker, recheckSeq]);
}

/**
 * スクリプトの型を確かめる（ADR 0058）。TypeScript の本体は大きいので Worker で動かし、
 * ワークスペースを開いたときに初めて読み込む。制作データが変わるたびに（少し待って）確かめ直す。
 * 型の誤りは作っている途中の問題で、再生は止めない。
 */
export function useTypeCheck(): void {
  const project = useWorkspace((s) => s.project);
  const ready = useWorkspace((s) => s.ready);
  const rev = useWorkspace((s) => s.rev);
  const packages = useWorkspace((s) => s.packages);
  const worker = useRef<TypecheckClient | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!project || !ready) return;
    const client = new TypecheckClient(
      new Worker(new URL("./typecheck.worker.ts", import.meta.url), { type: "module" }),
    );
    worker.current = client;
    setEditorTypecheck(client);
    return () => {
      client.dispose();
      worker.current = null;
      setEditorTypecheck(null);
    };
  }, [project, ready]);
  useEffect(() => {
    const client = worker.current;
    if (!project || !ready || !client) return;
    const id = ++seq.current;
    const input = {
      snapshot: project.snapshot(),
      packages: [...packages],
      hostDeclarations: HOST_DECLARATIONS,
    };
    client.updateContext(input);
    const timer = setTimeout(() => {
      void client.check(input).then((result) => {
        // 最後に頼んだものの結果だけを受け取る
        if (!result || id !== seq.current || useWorkspace.getState().project !== project) return;
        useWorkspace.setState({
          typeProblems: { diagnostics: result.diagnostics, observedVersion: rev },
          fieldSchemas: result.schemas,
        });
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [project, ready, rev, packages]);
}

/** いまのスクリプトの問題の一覧（current → stale、実行して止まったもの → 編集中の確認の順） */
export function useProblems(): Problem[] {
  const run = useWorkspace((s) => s.runProblems);
  const runSnap = useWorkspace((s) => s.runSnapshot);
  const project = useWorkspace((s) => s.project);
  const check = useWorkspace((s) => s.checkProblems);
  const types = useWorkspace((s) => s.typeProblems);
  const rev = useWorkspace((s) => s.rev);
  return useMemo(
    () =>
      viewDiagnostics(
        [...runSetsByChanges(run, runSnap, project?.snapshot() ?? null, rev), ...check, types],
        rev,
      ),
    [run, runSnap, project, check, types, rev],
  );
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
  const pool = useWorkspace((s) => s.packagePool);
  const schemas = useWorkspace((s) => s.fieldSchemas);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は制作データが変わった合図
  return useMemo(() => {
    if (!project) return { diagnostics: [], index: null, summary: new Map() };
    const snap = project.snapshot();
    const readable = project.snapshotWithPackages(schemas);
    const index = ResourcePathIndex.fromSnapshot(snap);
    const diagnostics = [
      ...checkProjectStructure(snap, index),
      ...checkProjectReferences(
        {
          ...readable,
          dependencies: [
            ...(snap.dependencies ?? []),
            ...reachablePackages(snap.dependencies, pool).map((r) => r.dependency),
          ],
        },
        project.prefabFieldSchemas(schemas),
      ),
      // 値が型に合っているか（ADR 0065）
      ...checkFieldValues(snap, schemas),
      ...checkPackageVersions(snap.dependencies, pool),
    ];
    return { diagnostics, index, summary: summarizeDiagnostics(diagnostics, index) };
  }, [project, rev, schemas]);
}

/** 制作データの依存グラフ（「どこで使っているか」の表示に使う）。制作データが変わるたびに作り直す */
export function useDependencyGraph(): ProjectDependencyGraph | null {
  const project = useWorkspace((s) => s.project);
  const rev = useWorkspace((s) => s.rev);
  const schemas = useWorkspace((s) => s.fieldSchemas);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は制作データが変わった合図
  return useMemo(
    () =>
      project
        ? ProjectDependencyGraph.fromSnapshot(project.snapshotWithPackages(schemas), schemas)
        : null,
    [project, rev, schemas],
  );
}

/**
 * 問題の一覧を一か所にまとめる：スクリプトの問題（編集中の確認・実行）と、
 * 制作データの問題（構造・リソース参照。いつも current）。
 * パネルの中身と、メインパネルのボタンの件数と、エラーで自動で開く判定で共用する。
 */
export function useWorkspaceProblems(): {
  items: DiagnosticView[];
  count: ReturnType<typeof countCurrent>;
  index: ResourcePathIndex | null;
} {
  const problems = useProblems();
  const { diagnostics, index } = useProjectDiagnostics();
  const items = useMemo<DiagnosticView[]>(
    () => [...problems, ...diagnostics.map((d) => ({ ...d, freshness: "current" as const }))],
    [problems, diagnostics],
  );
  const count = useMemo(() => countCurrent(items), [items]);
  return { items, count, index };
}

/**
 * Resources と Hierarchy の印に使う件数（計画 §8.6）。制作データの問題と、
 * スクリプトの問題を合わせて数える。編集した直後に印が消えて点滅しないよう、
 * 確かめ直すまでの編集前の結果も数える。
 * フォルダはその中の問題を、Entity は子の問題を、アウトプットは中の Entity と使う System の問題を数える。
 */
export function useProblemSummary(): {
  resources: Map<string, DiagnosticSummary>;
  hierarchy: Map<string, DiagnosticSummary>;
} {
  const project = useWorkspace((s) => s.project);
  const rev = useWorkspace((s) => s.rev);
  const { items, index } = useWorkspaceProblems();
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は制作データが変わった合図
  return useMemo(() => {
    return {
      resources: index ? summarizeDiagnostics(items, index) : new Map(),
      hierarchy: project
        ? summarizeHierarchy(items, project.entities(), project.outputs())
        : new Map(),
    };
  }, [items, index, project, rev]);
}

/**
 * 新しいエラーが出たら問題パネルを開く。すでに開いていれば前に出す（problemsFocus を進める）。
 * パネルを閉じても、同じエラーが残っている間は開き直さない（trackErrorPrints が覚えている）。
 */
export function useOpenProblemsOnError(): void {
  const { items } = useWorkspaceProblems();
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const known = useRef<ReadonlySet<string>>(new Set());
  // ワークスペースを変えたら、前の所のエラーの記憶は捨てる（下の判定より先に流れる）
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspaceId が変わること自体が合図
  useEffect(() => {
    known.current = new Set();
  }, [workspaceId]);
  useEffect(() => {
    const tracked = trackErrorPrints(known.current, items);
    known.current = tracked.known;
    if (tracked.appeared.length === 0) return;
    useWorkspace.setState((s) => ({ problemsOpen: true, problemsFocus: s.problemsFocus + 1 }));
  }, [items]);
}

/**
 * System の Query を読む関数（表示・Entity との照合用）。import した名前も文字列の名前も、
 * KokoState の ID に読み替える（ADR 0010）。
 */
export function useSystemQuery(): (systemId: string) => {
  with: QueryItem[];
  without: QueryItem[];
} {
  const project = useWorkspace((s) => s.project);
  const packages = useWorkspace((s) => s.packages);
  const { index } = useProjectDiagnostics();
  return (systemId) =>
    project && index
      ? readSystemQuery(systemId, project.code(systemId)?.toString() ?? "", index, packages)
      : { with: [], without: [] };
}

/**
 * 依存の中身を取り出し、その KokoState の定義を制作データ（ProjectDoc）に入れる（ADR 0015）。
 * Entity に付ける・Inspector で値を入れる・Query を読むのに使う。定義は同期も保存もしない。
 */
export function usePackageDefinitions(): void {
  const project = useWorkspace((s) => s.project);
  const ready = useWorkspace((s) => s.ready);
  useEffect(() => {
    if (!project || !ready) return;
    let last = "";
    let cancelled = false;
    const refresh = () => {
      // 依存が変わったときだけ取り出し直す
      const deps = project.dependencies();
      const key = JSON.stringify(deps);
      if (key === last) return;
      last = key;
      void Promise.all([resolvePackages(deps), resolvePackagePool(deps)]).then(([map, pool]) => {
        if (cancelled || last !== key || useWorkspace.getState().project !== project) return;
        // 入れ子のプレハブの表示には、依存先が使う KokoState の定義も要る。
        project.setPackageKokoStates(packageKokoStates(pool));
        project.setPackagePrefabs(pool);
        // 定義は Y.Doc の外なので、変わったことを rev で知らせる
        useWorkspace.setState((s) => ({ packages: map, packagePool: pool, rev: s.rev + 1 }));
      });
    };
    refresh();
    const unobserve = project.observe(refresh);
    return () => {
      cancelled = true;
      unobserve();
    };
  }, [project, ready]);
}

/** 依存から取り込んだ KokoState なら、その別名（`@別名` の表示用） */
export function packageAliasOf(project: ProjectDoc, kokoId: string): string | null {
  return project.dependencies().find((d) => belongsToDependency(kokoId, d))?.alias ?? null;
}
