import type { Vec3 } from "@tukurium/eks";
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
  const ws = useWorkspace.getState();
  const project = ws.project;
  if (!project) return [];
  switch (panelId) {
    case "ws-main": {
      const out = project.output(ws.outputId);
      return [
        `Output: ${out?.name ?? "-"}（${out?.kind ?? "-"}）`,
        ws.mode === "edit" ? "Edit mode" : ws.mode === "play" ? "Play mode" : "一時停止中",
        ...ws.logs.slice(-3).map((l) => `> ${l.message}`),
      ].slice(0, MAX_LINES);
    }
    case "ws-inspector": {
      const sel = ws.selection;
      if (!sel) return ["（何も選んでいません）"];
      if (sel.kind !== "entity") {
        const name =
          sel.kind === "output"
            ? project.output(sel.id)?.name
            : sel.kind === "system"
              ? project.system(sel.id)?.name
              : sel.kind === "material"
                ? project.material(sel.id)?.name
                : project.registry().get(sel.id)?.name;
        return [`${sel.kind}: ${name ?? sel.id}`];
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
    default:
      return [];
  }
}
