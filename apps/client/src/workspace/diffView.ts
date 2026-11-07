import { type FieldType, isResourceFieldType, type KokoStateDef } from "@tukurium/eks";
import {
  type AssetDef,
  BUILTIN_KOKOSTATES,
  type EntityDef,
  type FolderDef,
  type OutputDef,
  type ProjectSnapshot,
} from "@tukurium/repo-model";

/** 履歴と保存で出す、ひとつの変化。 */
export type DiffKind = "added" | "removed" | "modified";

export type DiffGroup =
  | "output"
  | "entity"
  | "code"
  | "koko"
  | "material"
  | "model"
  | "image"
  | "audio"
  | "other";

export interface DiffLine {
  label: string;
  /** null は、その側にない */
  before: string | null;
  after: string | null;
  /**
   * どの部分の変化か。元に戻す範囲と、Inspector の丸に出す行を決める。
   * entity：name / place / state:<KokoState> / field:<KokoState>:<欄>、
   * output：name / kind / exposure / guest / systems / keep、koko：name / field:<欄>、
   * code：name、material：name / color / roughness / metalness / map。ないものは添え書き。
   */
  part?: string;
  /**
   * まとめて見せる見出し（Entity の KokoState ごと）。同じ key の行は、見出しの下にまとめて並べ、
   * label は欄の名前だけにする。
   */
  section?: DiffSection;
}

export interface DiffSection {
  key: string;
  label: string;
  /** その KokoState を付けた・外した・中身を変えた */
  change: "added" | "removed" | "modified";
}

export interface CodeRow {
  kind: "same" | "add" | "del" | "gap";
  text: string;
}

export interface DiffPreview {
  kind: "model" | "image";
  beforeId: string | null;
  afterId: string | null;
}

export interface DiffEntry {
  id: string;
  group: DiffGroup;
  groupLabel: string;
  name: string;
  kind: DiffKind;
  /** 一覧に添える場所（アウトプットや親） */
  hint?: string;
  lines: DiffLine[];
  code?: CodeRow[];
  preview?: DiffPreview;
}

const GROUP_LABEL: Record<DiffGroup, string> = {
  output: "アウトプット",
  entity: "エンティティ",
  code: "コード",
  koko: "KokoState",
  material: "マテリアル",
  model: "モデル",
  image: "テクスチャ",
  audio: "音声",
  other: "その他",
};

const GROUP_ORDER: DiffGroup[] = [
  "output",
  "entity",
  "code",
  "koko",
  "material",
  "model",
  "image",
  "audio",
  "other",
];

const KIND_LABEL = { added: "新しい", removed: "消えた", modified: "変わった" } as const;

export function diffKindLabel(kind: DiffKind): string {
  return KIND_LABEL[kind];
}

/** 2 つの制作データを、名前で読める差分にする。同じものは出さない。 */
export function describeDiff(before: ProjectSnapshot, after: ProjectSnapshot): DiffEntry[] {
  const entries = [
    ...outputEntries(before, after),
    ...entityEntries(before, after),
    ...codeEntries(before, after),
    ...kokoEntries(before, after),
    ...materialEntries(before, after),
    ...assetEntries(before, after),
    ...otherEntries(before, after),
  ];
  return entries.sort((a, b) => {
    const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (g !== 0) return g;
    return a.name.localeCompare(b.name, "ja");
  });
}

/** コードの行差分。変わった行の前後だけ残し、離れたところは省略する。 */
export function lineDiff(before: string, after: string, context = 2): CodeRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  const rows = align(a, b);
  return compact(rows, context);
}

function outputEntries(before: ProjectSnapshot, after: ProjectSnapshot): DiffEntry[] {
  return pairById(before.outputs, after.outputs).flatMap(({ id, prev, next, kind }) => {
    const lines = outputLines(prev, next, before, after);
    if (lines.length === 0) return [];
    const name = next?.name ?? prev?.name ?? id;
    return [entry("output", id, name, kind, lines)];
  });
}

function entityEntries(before: ProjectSnapshot, after: ProjectSnapshot): DiffEntry[] {
  return pairById(before.entities, after.entities).flatMap(({ id, prev, next, kind }) => {
    const lines: DiffLine[] = [];
    if ((prev?.name ?? null) !== (next?.name ?? null)) {
      lines.push({
        label: "名前",
        before: prev?.name ?? null,
        after: next?.name ?? null,
        part: "name",
      });
    }
    if ((prev?.order ?? null) !== (next?.order ?? null) && prev && next) {
      lines.push({
        label: "並び",
        before: `${prev.order + 1}番目`,
        after: `${next.order + 1}番目`,
        part: "place",
      });
    }
    const outputChanged = (prev?.output ?? null) !== (next?.output ?? null);
    if (outputChanged) {
      lines.push({
        label: "アウトプット",
        before: prev ? outputName(before, prev.output) : null,
        after: next ? outputName(after, next.output) : null,
        part: "place",
      });
    }
    lines.push(...stateLines(id, prev, next, before, after));
    const parentChanged = (prev?.parent ?? null) !== (next?.parent ?? null);
    // アウトプットの名前が変わっただけでは、中のエンティティは出さない
    if (lines.length === 0 && !parentChanged && !outputChanged) return [];
    const shown = next ?? prev;
    if (!shown) return [];
    const beforePath = prev ? entityPath(before, prev) : null;
    const afterPath = next ? entityPath(after, next) : null;
    const path =
      parentChanged || outputChanged
        ? { label: "階層", before: beforePath, after: afterPath, part: "place" }
        : { label: "階層", before: afterPath ?? beforePath, after: afterPath ?? beforePath };
    const hint = placeHint(next ? after : before, shown);
    return [entry("entity", id, shown.name, kind, [path, ...lines], hint)];
  });
}

function codeEntries(before: ProjectSnapshot, after: ProjectSnapshot): DiffEntry[] {
  return pairById(before.systems, after.systems).flatMap(({ id, prev, next, kind }) => {
    const lines: DiffLine[] = [];
    pushIfChanged(lines, "名前", prev?.name ?? null, next?.name ?? null, "name");
    const beforeCode = prev?.code ?? "";
    const afterCode = next?.code ?? "";
    const code = beforeCode === afterCode ? undefined : lineDiff(beforeCode, afterCode);
    if (lines.length === 0 && !code) return [];
    return [entry("code", id, next?.name ?? prev?.name ?? id, kind, lines, undefined, code)];
  });
}

function kokoEntries(before: ProjectSnapshot, after: ProjectSnapshot): DiffEntry[] {
  return pairById(before.kokostates, after.kokostates).flatMap(({ id, prev, next, kind }) => {
    const lines: DiffLine[] = [];
    pushIfChanged(lines, "名前", prev?.name ?? null, next?.name ?? null, "name");
    const fields = new Map<
      string,
      { prev?: KokoStateDef["fields"][number]; next?: KokoStateDef["fields"][number] }
    >();
    for (const f of prev?.fields ?? []) fields.set(f.id, { prev: f });
    for (const f of next?.fields ?? []) {
      const row = fields.get(f.id) ?? {};
      row.next = f;
      fields.set(f.id, row);
    }
    for (const [fid, { prev: pf, next: nf }] of fields) {
      const name = nf?.name ?? pf?.name ?? "";
      if (!pf || !nf) {
        lines.push({
          label: `欄 ${name}`,
          before: pf ? fieldSummary(pf, before) : null,
          after: nf ? fieldSummary(nf, after) : null,
          part: `field:${fid}`,
        });
        continue;
      }
      if (pf.name !== nf.name || pf.type !== nf.type || !same(pf.default, nf.default)) {
        lines.push({
          label: `欄 ${nf.name}`,
          before: fieldSummary(pf, before),
          after: fieldSummary(nf, after),
          part: `field:${fid}`,
        });
      }
    }
    if (lines.length === 0) return [];
    return [entry("koko", id, next?.name ?? prev?.name ?? id, kind, lines)];
  });
}

function materialEntries(before: ProjectSnapshot, after: ProjectSnapshot): DiffEntry[] {
  return pairById(before.materials, after.materials).flatMap(({ id, prev, next, kind }) => {
    const lines: DiffLine[] = [];
    pushIfChanged(lines, "名前", prev?.name ?? null, next?.name ?? null, "name");
    pushIfChanged(lines, "色", prev?.color ?? null, next?.color ?? null, "color");
    pushIfChanged(
      lines,
      "粗さ",
      prev ? String(prev.roughness) : null,
      next ? String(next.roughness) : null,
      "roughness",
    );
    pushIfChanged(
      lines,
      "金属",
      prev ? String(prev.metalness) : null,
      next ? String(next.metalness) : null,
      "metalness",
    );
    const beforeMap = prev?.map ?? null;
    const afterMap = next?.map ?? null;
    if (beforeMap !== afterMap) {
      lines.push({
        label: "テクスチャ",
        before: beforeMap ? resourceName(before, beforeMap) : null,
        after: afterMap ? resourceName(after, afterMap) : null,
        part: "map",
      });
    }
    if (lines.length === 0) return [];
    const preview =
      beforeMap !== afterMap && (beforeMap || afterMap)
        ? { kind: "image" as const, beforeId: beforeMap, afterId: afterMap }
        : undefined;
    return [
      entry(
        "material",
        id,
        next?.name ?? prev?.name ?? id,
        kind,
        lines,
        undefined,
        undefined,
        preview,
      ),
    ];
  });
}

function assetEntries(before: ProjectSnapshot, after: ProjectSnapshot): DiffEntry[] {
  const prevById = new Map((before.assets ?? []).map((a) => [a.id, a]));
  const nextById = new Map((after.assets ?? []).map((a) => [a.id, a]));
  const usedPrev = new Set<string>();
  const usedNext = new Set<string>();
  const out: DiffEntry[] = [];
  for (const [id, next] of nextById) {
    const prev = prevById.get(id);
    if (!prev) continue;
    usedPrev.add(id);
    usedNext.add(id);
    if (prev.name === next.name && prev.kind === next.kind) continue;
    out.push(assetEntry(prev, next, "modified"));
  }
  const removed = [...prevById.values()].filter((a) => !usedPrev.has(a.id));
  const added = [...nextById.values()].filter((a) => !usedNext.has(a.id));
  for (const prev of removed) {
    const at = added.findIndex((n) => n.kind === prev.kind && n.name === prev.name);
    if (at >= 0) {
      const [next] = added.splice(at, 1);
      if (next) out.push(assetEntry(prev, next, "modified"));
    } else {
      out.push(assetEntry(prev, undefined, "removed"));
    }
  }
  for (const next of added) out.push(assetEntry(undefined, next, "added"));
  return out;
}

function otherEntries(before: ProjectSnapshot, after: ProjectSnapshot): DiffEntry[] {
  const out: DiffEntry[] = [];
  if (before.name !== after.name) {
    out.push(
      entry("other", "name", "プロジェクト名", "modified", [
        { label: "名前", before: before.name, after: after.name },
      ]),
    );
  }
  const folderLines = folderLinesOf(before, after);
  if (folderLines.length > 0) {
    out.push(entry("other", "folders", "フォルダ", "modified", folderLines));
  }
  const placeLines = placementLines(before, after);
  if (placeLines.length > 0) {
    out.push(entry("other", "placement", "置き場所", "modified", placeLines));
  }
  const depBefore = (before.dependencies ?? []).map((d) => `@${d.alias} v${d.version}`).join("、");
  const depAfter = (after.dependencies ?? []).map((d) => `@${d.alias} v${d.version}`).join("、");
  if (depBefore !== depAfter) {
    out.push(
      entry("other", "deps", "ライブラリ", "modified", [
        { label: "使うライブラリ", before: depBefore || null, after: depAfter || null },
      ]),
    );
  }
  const fromBefore = provenanceText(before);
  const fromAfter = provenanceText(after);
  if (fromBefore !== fromAfter) {
    out.push(
      entry("other", "provenance", "由来", "modified", [
        { label: "由来", before: fromBefore, after: fromAfter },
      ]),
    );
  }
  return out;
}

function assetEntry(
  prev: AssetDef | undefined,
  next: AssetDef | undefined,
  kind: DiffKind,
): DiffEntry {
  const asset = next ?? prev;
  const group: DiffGroup =
    asset?.kind === "model" ? "model" : asset?.kind === "image" ? "image" : "audio";
  const lines: DiffLine[] = [];
  if ((prev?.name ?? null) !== (next?.name ?? null)) {
    lines.push({ label: "名前", before: prev?.name ?? null, after: next?.name ?? null });
  }
  const preview =
    group === "audio"
      ? undefined
      : {
          kind: group,
          beforeId: prev?.id ?? null,
          afterId: next?.id ?? null,
        };
  return entry(
    group,
    `${prev?.id ?? ""}>${next?.id ?? ""}`,
    asset?.name ?? "素材",
    kind,
    lines,
    undefined,
    undefined,
    preview,
  );
}

function outputLines(
  prev: OutputDef | undefined,
  next: OutputDef | undefined,
  before: ProjectSnapshot,
  after: ProjectSnapshot,
): DiffLine[] {
  const lines: DiffLine[] = [];
  pushIfChanged(lines, "名前", prev?.name ?? null, next?.name ?? null, "name");
  pushIfChanged(
    lines,
    "種類",
    prev ? kindLabel(prev.kind) : null,
    next ? kindLabel(next.kind) : null,
    "kind",
  );
  pushIfChanged(
    lines,
    "外からの見え方",
    prev ? exposureLabel(prev.exposure ?? "interactive") : null,
    next ? exposureLabel(next.exposure ?? "interactive") : null,
    "exposure",
  );
  const guestBefore = prev?.kind === "world" ? guestLabel(prev.guestPolicy ?? "interactive") : null;
  const guestAfter = next?.kind === "world" ? guestLabel(next.guestPolicy ?? "interactive") : null;
  pushIfChanged(lines, "外から来た Item", guestBefore, guestAfter, "guest");
  pushIfChanged(
    lines,
    "システム",
    prev ? systemList(prev, before) : null,
    next ? systemList(next, after) : null,
    "systems",
  );
  pushIfChanged(
    lines,
    "含めるリソース",
    prev?.kind === "library" ? resourceList(prev, before) : null,
    next?.kind === "library" ? resourceList(next, after) : null,
    "resources",
  );
  pushIfChanged(
    lines,
    "状態維持",
    prev ? keepList(prev, before) : null,
    next ? keepList(next, after) : null,
    "keep",
  );
  return lines;
}

function stateLines(
  id: string,
  prev: EntityDef | undefined,
  next: EntityDef | undefined,
  before: ProjectSnapshot,
  after: ProjectSnapshot,
): DiffLine[] {
  const lines: DiffLine[] = [];
  const prevStates = prev?.states ?? {};
  const nextStates = next?.states ?? {};
  const kokos = new Set([...Object.keys(prevStates), ...Object.keys(nextStates)]);
  for (const koko of kokos) {
    const def =
      kokoDef(koko, next ? after : before) ?? kokoDef(koko, before) ?? kokoDef(koko, after);
    const name = def?.name ?? koko;
    const had = koko in prevStates;
    const has = koko in nextStates;
    // KokoState ごとに見出しを立て、その下に欄をまとめる
    const section: DiffSection = {
      key: `state:${koko}`,
      label: name,
      change: !had ? "added" : !has ? "removed" : "modified",
    };
    const own: DiffLine[] = [];
    const values = fieldLines(
      koko,
      def,
      had ? prevStates[koko] : undefined,
      has ? nextStates[koko] : undefined,
      before,
      after,
    );
    // 付けた・外したのに欄の行が出ない（欄がない、値が空）ときは、付け外しの行を出す
    if ((!had || !has) && values.length === 0) {
      own.push({
        label: "付け外し",
        before: had ? "付いている" : null,
        after: has ? "付いている" : null,
        part: `state:${koko}`,
      });
    }
    own.push(...values);
    const fieldIds = new Set([
      ...Object.keys(prevStates[koko] ?? {}),
      ...Object.keys(nextStates[koko] ?? {}),
      ...(def?.fields.map((f) => f.id) ?? []),
    ]);
    for (const field of fieldIds) {
      const beforeKeep = prev ? kept(before, prev.output, id, koko, field) : false;
      const afterKeep = next ? kept(after, next.output, id, koko, field) : false;
      if (beforeKeep === afterKeep) continue;
      const fieldName = def?.fields.find((f) => f.id === field)?.name ?? field;
      own.push({
        label: `${fieldName} の維持`,
        before: beforeKeep ? "付ける" : "外す",
        after: afterKeep ? "付ける" : "外す",
        part: `field:${koko}:${field}`,
      });
    }
    lines.push(...own.map((l) => ({ ...l, section })));
  }
  return lines;
}

function fieldLines(
  koko: string,
  def: KokoStateDef | undefined,
  beforeVals: Record<string, unknown> | undefined,
  afterVals: Record<string, unknown> | undefined,
  before: ProjectSnapshot,
  after: ProjectSnapshot,
): DiffLine[] {
  const order = def?.fields.map((f) => f.id) ?? [];
  const ids = [
    ...new Set([...Object.keys(beforeVals ?? {}), ...Object.keys(afterVals ?? {})]),
  ].sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b, "ja");
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  const lines: DiffLine[] = [];
  for (const id of ids) {
    const field = def?.fields.find((f) => f.id === id);
    const had = beforeVals !== undefined && Object.hasOwn(beforeVals, id);
    const has = afterVals !== undefined && Object.hasOwn(afterVals, id);
    if (had && has && same(beforeVals?.[id], afterVals?.[id])) continue;
    lines.push({
      label: field?.name ?? id,
      before: had ? show(beforeVals?.[id], field?.type, before) : null,
      after: has ? show(afterVals?.[id], field?.type, after) : null,
      part: `field:${koko}:${id}`,
    });
  }
  return lines;
}

function folderLinesOf(before: ProjectSnapshot, after: ProjectSnapshot): DiffLine[] {
  const lines: DiffLine[] = [];
  const prev = new Map((before.folders ?? []).map((f) => [f.id, f]));
  const next = new Map((after.folders ?? []).map((f) => [f.id, f]));
  for (const id of new Set([...prev.keys(), ...next.keys()])) {
    const a = prev.get(id);
    const b = next.get(id);
    const ap = a ? folderPath(before.folders ?? [], a.id) : null;
    const bp = b ? folderPath(after.folders ?? [], b.id) : null;
    if (ap !== bp) lines.push({ label: "フォルダ", before: ap, after: bp });
  }
  return lines;
}

function placementLines(before: ProjectSnapshot, after: ProjectSnapshot): DiffLine[] {
  const prev = before.placement ?? {};
  const next = after.placement ?? {};
  const lines: DiffLine[] = [];
  for (const id of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if ((prev[id] ?? null) === (next[id] ?? null)) continue;
    lines.push({
      label: resourceName(after, id) || resourceName(before, id),
      before: prev[id] ? folderPath(before.folders ?? [], prev[id]) || "（不明）" : "いちばん上",
      after: next[id] ? folderPath(after.folders ?? [], next[id]) || "（不明）" : "いちばん上",
    });
  }
  return lines;
}

function entry(
  group: DiffGroup,
  id: string,
  name: string,
  kind: DiffKind,
  lines: DiffLine[],
  hint?: string,
  code?: CodeRow[],
  preview?: DiffPreview,
): DiffEntry {
  return {
    id: `${group}:${id}`,
    group,
    groupLabel: GROUP_LABEL[group],
    name,
    kind,
    hint,
    lines,
    code,
    preview,
  };
}

function pairById<T extends { id: string }>(
  before: T[],
  after: T[],
): { id: string; prev?: T; next?: T; kind: DiffKind }[] {
  const prev = new Map(before.map((x) => [x.id, x]));
  const next = new Map(after.map((x) => [x.id, x]));
  return [...new Set([...prev.keys(), ...next.keys()])].map((id) => {
    const a = prev.get(id);
    const b = next.get(id);
    const kind: DiffKind = !a ? "added" : !b ? "removed" : "modified";
    return { id, prev: a, next: b, kind };
  });
}

function entityPath(snap: ProjectSnapshot, entity: EntityDef): string {
  const byId = new Map(snap.entities.map((e) => [e.id, e]));
  const names: string[] = [];
  let cur: EntityDef | undefined = entity;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    names.push(cur.name);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  names.reverse();
  const root = outputName(snap, entity.output);
  return [root, ...names].filter((p) => p.length > 0).join(" / ");
}

function placeHint(snap: ProjectSnapshot, entity: EntityDef): string {
  const full = entityPath(snap, entity);
  const cut = full.slice(0, Math.max(0, full.length - entity.name.length)).replace(/ \/ $/, "");
  return cut || outputName(snap, entity.output);
}

function outputName(snap: ProjectSnapshot, id: string): string {
  return snap.outputs.find((o) => o.id === id)?.name ?? "";
}

function kokoDef(id: string, snap: ProjectSnapshot): KokoStateDef | undefined {
  return BUILTIN_KOKOSTATES.find((k) => k.id === id) ?? snap.kokostates.find((k) => k.id === id);
}

function kept(
  snap: ProjectSnapshot,
  outputId: string,
  entity: string,
  koko: string,
  field: string,
): boolean {
  const output = snap.outputs.find((o) => o.id === outputId);
  return (
    output?.keep.some((k) => k.entity === entity && k.koko === koko && k.field === field) ?? false
  );
}

function systemList(output: OutputDef, snap: ProjectSnapshot): string {
  if (output.systems.length === 0) return "（なし）";
  return output.systems
    .map((s) => {
      const name = snap.systems.find((x) => x.id === s.id)?.name ?? s.id;
      return s.enabled ? name : `${name}（停止）`;
    })
    .join("、");
}

function keepList(output: OutputDef, snap: ProjectSnapshot): string {
  if (output.keep.length === 0) return "（なし）";
  return output.keep
    .map((k) => {
      const ent = snap.entities.find((e) => e.id === k.entity)?.name ?? k.entity;
      const def = kokoDef(k.koko, snap);
      const field = def?.fields.find((f) => f.id === k.field)?.name ?? k.field;
      return `${ent} の ${def?.name ?? k.koko} / ${field}`;
    })
    .join("、");
}

function fieldSummary(field: KokoStateDef["fields"][number], snap: ProjectSnapshot): string {
  return `${field.name}（${field.type}、初期値 ${show(field.default, field.type, snap)}）`;
}

function resourceName(snap: ProjectSnapshot, id: string): string {
  return (
    snap.materials.find((m) => m.id === id)?.name ??
    snap.assets?.find((a) => a.id === id)?.name ??
    snap.entities.find((e) => e.id === id)?.name ??
    snap.kokostates.find((k) => k.id === id)?.name ??
    snap.systems.find((s) => s.id === id)?.name ??
    id
  );
}

/** ライブラリに含めるリソースの名前（名前の順） */
function resourceList(o: OutputDef, snap: ProjectSnapshot): string {
  const names = (o.resources ?? [])
    .map((id) => resourceName(snap, id))
    .sort((a, b) => a.localeCompare(b, "ja"));
  return names.length > 0 ? names.join("、") : "（なし）";
}

function provenanceText(snap: ProjectSnapshot): string {
  const rows = snap.provenance ?? [];
  if (rows.length === 0) return "（なし）";
  return rows
    .map((p) => {
      const kind = p.kind === "fork" ? "フォーク" : "抽出";
      const items = p.items.length > 0 ? p.items.join("、") : "中身なし";
      return `${kind} ${p.repoName}（${items}）`;
    })
    .join(" / ");
}

function folderPath(folders: FolderDef[], id: string): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names: string[] = [];
  let cur = byId.get(id);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    names.push(cur.name);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return names.reverse().join(" / ");
}

function pushIfChanged(
  lines: DiffLine[],
  label: string,
  before: string | null,
  after: string | null,
  part?: string,
) {
  if (before === after) return;
  lines.push({ label, before, after, part });
}

const SHAPE: Record<string, string> = {
  box: "ボックス",
  sphere: "球",
  cylinder: "円柱",
  capsule: "カプセル",
  plane: "平面",
};

const EXPOSURE: Record<string, string> = {
  interactive: "インタラクション可能",
  collision: "衝突のみ",
  private: "非公開",
};

const GUEST: Record<string, string> = {
  interactive: "インタラクション可能",
  collision: "衝突のみ",
  deny: "許さない",
};

function kindLabel(kind: OutputDef["kind"]): string {
  if (kind === "item") return "アイテム";
  if (kind === "world") return "ワールド";
  return "ライブラリ";
}

function exposureLabel(value: string): string {
  return EXPOSURE[value] ?? value;
}

function guestLabel(value: string): string {
  return GUEST[value] ?? value;
}

function show(value: unknown, type: FieldType | undefined, snap: ProjectSnapshot): string {
  if (value === null || value === undefined) return "（なし）";
  if (typeof value === "boolean") return value ? "はい" : "いいえ";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value === "") return "（空）";
    if (type === "entity" || (type && isResourceFieldType(type))) return resourceName(snap, value);
    if (type === "string" && SHAPE[value]) return SHAPE[value];
    return value;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) return value.join(", ");
  return JSON.stringify(value);
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** エディタの左に出す、行ごとの変化（行番号は今のコードの 1 始まり） */
export interface LineChanges {
  /** 新しく足した行 */
  added: Set<number>;
  /** 書き換えた行 */
  modified: Set<number>;
  /** この行のすぐ下で行を消した（0 は先頭より上） */
  deletedAfter: Set<number>;
}

/**
 * 保存したコードと今のコードを行で比べる（VSCode の溝の印のように）。
 * 消した行と足した行が並んでいれば、その分は「書き換えた」にし、余った分を足した・消したにする。
 * 前後の同じ行は先に除いてから比べる（長いコードでも、変えたところが小さければ速い）。
 */
export function lineChanges(before: string, after: string): LineChanges {
  const a = splitLines(before);
  const b = splitLines(after);
  const out: LineChanges = { added: new Set(), modified: new Set(), deletedAfter: new Set() };
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const rows: CodeRow[] =
    midA.length * midB.length > 250_000
      ? [
          ...midA.map((text) => ({ kind: "del" as const, text })),
          ...midB.map((text) => ({ kind: "add" as const, text })),
        ]
      : align(midA, midB);
  let line = head;
  let i = 0;
  while (i < rows.length) {
    if (rows[i]?.kind === "same") {
      line++;
      i++;
      continue;
    }
    let dels = 0;
    let adds = 0;
    const start = line;
    while (i < rows.length && rows[i]?.kind !== "same") {
      if (rows[i]?.kind === "del") dels++;
      else adds++;
      i++;
    }
    for (let k = 1; k <= adds; k++) {
      if (k <= dels) out.modified.add(start + k);
      else out.added.add(start + k);
    }
    if (dels > adds) out.deletedAfter.add(start + adds);
    line = start + adds;
  }
  return out;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function align(a: string[], b: string[]): CodeRow[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const below = dp[i + 1];
    if (!row || !below) continue;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const rows: CodeRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      rows.push({ kind: "del", text: a[i] ?? "" });
      i++;
    } else {
      rows.push({ kind: "add", text: b[j] ?? "" });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "del", text: a[i++] ?? "" });
  while (j < m) rows.push({ kind: "add", text: b[j++] ?? "" });
  return rows;
}

function compact(rows: CodeRow[], context: number): CodeRow[] {
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.kind === "same") return;
    for (
      let j = Math.max(0, index - context);
      j <= Math.min(rows.length - 1, index + context);
      j++
    ) {
      keep.add(j);
    }
  });
  if (keep.size === rows.length) return rows;
  const out: CodeRow[] = [];
  let skipping = false;
  rows.forEach((row, index) => {
    if (!keep.has(index)) {
      if (!skipping && out.length > 0) out.push({ kind: "gap", text: "…" });
      skipping = true;
      return;
    }
    skipping = false;
    out.push(row);
  });
  return out;
}
