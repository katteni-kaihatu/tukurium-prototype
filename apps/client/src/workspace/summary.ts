import type { Vec3 } from "@tukurium/eks";
import { countCurrent, viewDiagnostics } from "@tukurium/repo-model";
import { useApp } from "../app/store";
import { useWorkspace } from "./store";

const MAX_LINES = 9;

const fmt = (v: unknown): string => {
  if (Array.isArray(v)) return (v as Vec3).map((n) => Math.round(n * 100) / 100).join(", ");
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  return String(v);
};

/**
 * パネルの中身を、他の人に見せる数行の要約にする（閲覧権限のある人にだけ届く）。
 * 入力途中の文字やスクロール位置は共有しない（要件 §6 の未決定事項。初版は要約のみ）。
 */
export function summarize(panelId: string): string[] {
  if (panelId === "session-belongings") {
    const world = useApp.getState().session?.placements.find((p) => p.outputKind === "world");
    return world ? [`開いているワールド: ${world.outputName}`] : ["ワールドはまだ開いていません"];
  }
  const ws = useWorkspace.getState();
  const project = ws.project;
  if (!project) return [];
  switch (panelId) {
    case "ws-main": {
      const out = project.output(ws.outputId);
      return [
        `Output: ${out?.name ?? "-"}（${out?.kind ?? "-"}）`,
        ws.mode === "edit" ? "Edit mode" : ws.mode === "play" ? "Play mode" : "一時停止中",
      ].slice(0, MAX_LINES);
    }
    case "ws-session": {
      const session = useApp.getState().session;
      const links = (session?.placements ?? []).filter(
        (p) => p.workspaceId === ws.workspaceId && p.outputId === ws.outputId,
      );
      return [
        `リンク先 ${links.length}`,
        ...links.map((p, i) => `${p.outputName} #${i + 1}`),
      ].slice(0, MAX_LINES);
    }
    case "ws-problems": {
      // 要約は定期的に作り直すので、ここでは軽く数えられるスクリプト・実行の問題だけにする
      const count = countCurrent(viewDiagnostics([ws.runProblems, ...ws.checkProblems], ws.rev));
      if (count.errors + count.warnings === 0 && count.stale === 0) return ["エラーはありません"];
      return [
        `エラー・注意 ${count.errors + count.warnings}${count.stale ? `（編集前の結果 ${count.stale}）` : ""}`,
      ];
    }
    case "ws-log":
      return ws.logs.length === 0
        ? ["ログはまだありません"]
        : ws.logs.slice(-MAX_LINES).map((l) => `> ${l.message}`);
    case "ws-inspector": {
      const sel = ws.selection;
      if (!sel) return ["（何も選んでいません）"];
      if (sel.kind === "output") {
        return [`output: ${project.output(sel.id)?.name ?? sel.id}`];
      }
      const e = project.entity(sel.id);
      if (!e) return [];
      const registry = project.registry();
      const lines = [e.name];
      for (const [koko, values] of Object.entries(e.states)) {
        const def = registry.get(koko);
        if (!def) continue;
        lines.push(def.name);
        for (const f of def.fields.slice(0, 3)) lines.push(`  ${f.name}  ${fmt(values[f.id])}`);
      }
      return lines.slice(0, MAX_LINES);
    }
    case "ws-detail": {
      const d = ws.detail;
      if (!d) return [];
      const name =
        d.kind === "system"
          ? project.system(d.id)?.name
          : d.kind === "material"
            ? project.material(d.id)?.name
            : d.kind === "asset"
              ? project.asset(d.id)?.name
              : d.kind === "folder"
                ? project.folders().find((f) => f.id === d.id)?.name
                : project.registry().get(d.id)?.name;
      const label =
        d.kind === "system"
          ? "Script"
          : d.kind === "material"
            ? "Material"
            : d.kind === "asset"
              ? project.asset(d.id)?.kind === "model"
                ? "Model"
                : "Texture"
              : d.kind === "folder"
                ? "Folder"
                : "KokoState";
      return [`${label}: ${name ?? d.id}`];
    }
    case "ws-resources":
      return [
        ...project.kokostates().map((k) => `KokoState  ${k.name}`),
        ...project.systems().map((s) => `System  ${s.name}`),
      ].slice(0, MAX_LINES);
    case "ws-editor": {
      const id = ws.activeSystem;
      if (!id) return [];
      const code = project.code(id)?.toString() ?? "";
      return [`${project.system(id)?.name ?? id}.js`, ...code.split("\n").slice(0, MAX_LINES - 1)];
    }
    case "ws-members":
      return ["権限の設定"];
    case "ws-history":
      return ["履歴"];
    case "ws-save":
      return ["保存"];
    case "ws-import":
      return ["ほかのプロジェクトから取り込む"];
    default:
      return [];
  }
}
