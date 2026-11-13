import type { KokoStateDef } from "@tukurium/eks";
import {
  equalValues,
  type FieldSchemas,
  schemaOfField,
  visitRefs,
  visitStateRefs,
} from "@tukurium/eks";
import { BUILTIN_KOKOSTATES, isBuiltin, RESOURCE_FIELD_KIND } from "../builtins";
import { belongsToDependency, isPackageResourceId } from "../packageDependency";
import { ResourcePathIndex } from "../resourcePath";
import type { ProjectSnapshot } from "../schema";
import { compileSystem } from "../systemCompiler";
import { type Diagnostic, type DiagnosticInput, makeDiagnostic, type ResourceRef } from "./types";

/** リソース参照の検査（ADR 0010）：Material・Entity・アウトプットが指すものがあるか */
export const REFERENCES_PROVIDER = "references";

type ResKind = "material" | "model" | "image" | "audio";
const RES_LABEL: Record<ResKind, string> = {
  material: "マテリアル",
  model: "モデル",
  image: "画像",
  audio: "音声",
};

/**
 * schemas：TypeScript で作ったフィールドのスキーマ（あれば、入れ子の中の参照まで確かめる）。
 * なくても、Tukurium が用意する型のフィールドは確かめる。
 */
export function checkProjectReferences(
  snap: ProjectSnapshot,
  schemas?: FieldSchemas,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (d: Omit<DiagnosticInput, "phase" | "provider">) =>
    out.push(makeDiagnostic({ ...d, phase: "authoring", provider: REFERENCES_PROVIDER }));

  /** リソース ID → 種類（マテリアルと素材） */
  const resources = new Map<string, ResKind>();
  for (const m of snap.materials) resources.set(m.id, "material");
  for (const a of snap.assets ?? []) resources.set(a.id, a.kind);
  const defs = new Map<string, KokoStateDef>();
  for (const k of [...BUILTIN_KOKOSTATES, ...snap.kokostates]) defs.set(k.id, k);
  const entities = new Map(snap.entities.map((e) => [e.id, e]));
  const outputs = new Map(snap.outputs.map((o) => [o.id, o]));
  const systems = new Set(snap.systems.map((s) => s.id));

  /** 参照を確かめ、問題があれば出す。expected が null なら種類は問わない */
  const checkResource = (
    subject: ResourceRef,
    path: string[],
    id: string,
    expected: ResKind | null,
    what: string,
    related: ResourceRef[] = [],
  ) => {
    const actual = resources.get(id);
    if (!actual)
      push({
        code: "missing-resource",
        severity: "error",
        subject,
        location: { kind: "property", path },
        related,
        message: `${what} に指定した${expected ? RES_LABEL[expected] : "リソース"}がありません`,
        detail: `ID: ${id}`,
      });
    else if (expected && actual !== expected)
      push({
        code: "wrong-resource-kind",
        severity: "error",
        subject,
        location: { kind: "property", path },
        related,
        message: `${what} には${RES_LABEL[expected]}を指定します（いまは${RES_LABEL[actual]}）`,
      });
  };

  // KokoState が使う型の定義（ADR 0065）。ライブラリの型の定義（`pkg:` の ID）は、依存の中身にある
  const typeDefs = new Set((snap.types ?? []).map((t) => t.id));
  for (const k of snap.kokostates)
    for (const id of k.typeDefs ?? [])
      if (!typeDefs.has(id) && !isPackageResourceId(id))
        push({
          code: "missing-typedef",
          severity: "error",
          subject: { kind: "kokostate", id: k.id },
          location: { kind: "property", path: ["typeDefs"] },
          related: [],
          message: `「${k.name}」が使う型の定義がありません`,
          detail: `ID: ${id}`,
        });

  for (const m of snap.materials)
    if (m.map)
      checkResource({ kind: "material", id: m.id }, ["map"], m.map, "image", `「${m.name}」の map`);

  for (const e of snap.entities) {
    const subject: ResourceRef = { kind: "entity", id: e.id };
    for (const [kokoId, values] of Object.entries(e.states)) {
      if (isPackageResourceId(kokoId)) {
        // ライブラリの定義は依存の中身にあるので、ここでは今の依存のものかだけを見る（ADR 0015）
        if ((snap.dependencies ?? []).some((d) => belongsToDependency(kokoId, d))) continue;
        push({
          code: "package-kokostate-not-in-dependencies",
          severity: "warning",
          subject,
          location: { kind: "property", path: [kokoId] },
          related: [],
          message: `「${e.name}」が持っているライブラリの KokoState は、今の依存にありません（版を変えたか、外しました）`,
          detail: `ID: ${kokoId}`,
        });
        continue;
      }
      const def = defs.get(kokoId);
      if (!def) {
        push({
          code: "missing-kokostate",
          severity: "warning",
          subject,
          location: { kind: "property", path: [kokoId] },
          related: [],
          message: `「${e.name}」が持っている KokoState の定義がありません`,
          detail: `ID: ${kokoId}`,
        });
        continue;
      }
      const related: ResourceRef[] = def.builtin ? [] : [{ kind: "kokostate", id: def.id }];
      for (const f of def.fields) {
        const schema = schemaOfField(schemas, kokoId, f);
        if (!schema) continue;
        const what = `「${e.name}」の ${def.name}.${f.name}`;
        visitRefs(schema, values[f.id], (target, v) => {
          if (target !== "entity")
            checkResource(subject, [kokoId, f.id], v, RESOURCE_FIELD_KIND[target], what, related);
          else if (!entities.has(v))
            push({
              code: "missing-entity",
              severity: "error",
              subject,
              location: { kind: "property", path: [kokoId, f.id] },
              related,
              message: `${what} に指定した Entity がありません`,
              detail: `ID: ${v}`,
            });
        });
        // KokoState の参照・フィールドの参照（ADR 0065）：指す Entity が、その KokoState とフィールドを持っているか
        visitStateRefs(schema, values[f.id], (ref, refSchema) => {
          const target = entities.get(ref.entity);
          // Entity がないことは、上で問題にしている
          if (!target) return;
          const targetDef = defs.get(ref.koko);
          const kokoName = targetDef?.name ?? ref.koko;
          const refProblem = (code: string, message: string, detail?: string) =>
            push({
              code,
              severity: "error",
              subject,
              location: { kind: "property", path: [kokoId, f.id] },
              related,
              message,
              ...(detail ? { detail } : {}),
            });
          if (!Object.hasOwn(target.states, ref.koko)) {
            refProblem(
              "missing-state-ref",
              `${what} が指す「${target.name}」は、KokoState「${kokoName}」を持っていません`,
              `KokoState の ID: ${ref.koko}`,
            );
            return;
          }
          if (refSchema.kind !== "fieldRef" || !targetDef) return;
          const field = targetDef.fields.find((x) => x.id === ref.field);
          if (!field) {
            refProblem(
              "missing-field-ref",
              `${what} が指す「${target.name}」の ${kokoName} に、指定したフィールドがありません`,
              `フィールドの ID: ${ref.field}`,
            );
            return;
          }
          // 指せるフィールドの型が決まっているときは、指したフィールドの型が同じかを見る
          const fieldSchema = schemaOfField(schemas, ref.koko, field);
          if (refSchema.value && fieldSchema && !equalValues(refSchema.value, fieldSchema))
            refProblem(
              "field-ref-type-mismatch",
              `${what} は、${kokoName}.${field.name}（${field.type}）を指せません（型が合いません）`,
            );
        });
      }
    }

    if (!outputs.has(e.output))
      push({
        code: "entity-output-missing",
        severity: "error",
        subject,
        location: null,
        related: [],
        message: `「${e.name}」が入っているアウトプットがありません`,
      });
    if (e.parent !== null) {
      const parent = entities.get(e.parent);
      if (!parent)
        push({
          code: "entity-parent-missing",
          severity: "error",
          subject,
          location: null,
          related: [],
          message: `「${e.name}」の親の Entity がありません`,
        });
      else if (parent.output !== e.output)
        push({
          code: "entity-parent-other-output",
          severity: "error",
          subject,
          location: null,
          related: [{ kind: "entity", id: parent.id }],
          message: `「${e.name}」の親「${parent.name}」が別のアウトプットにあります`,
        });
    }
  }

  // Entity の親子の輪（マージなどで起こりうる）。輪ごとに一件
  const done = new Set<string>();
  for (const start of snap.entities) {
    const trail: string[] = [];
    let cur: string | null = start.id;
    while (cur && !done.has(cur) && entities.has(cur)) {
      const at = trail.indexOf(cur);
      if (at >= 0) {
        const [first, ...rest] = trail.slice(at).sort();
        if (first !== undefined)
          push({
            code: "entity-parent-cycle",
            severity: "error",
            subject: { kind: "entity", id: first },
            location: null,
            related: rest.map((id) => ({ kind: "entity", id })),
            message: `Entity「${[first, ...rest].map((id) => entities.get(id)?.name ?? id).join("」「")}」が互いの子になっています`,
          });
        break;
      }
      trail.push(cur);
      cur = entities.get(cur)?.parent ?? null;
    }
    for (const id of trail) done.add(id);
  }

  for (const o of snap.outputs) {
    const subject: ResourceRef = { kind: "output", id: o.id };
    if (o.thumbnail)
      checkResource(subject, ["thumbnail"], o.thumbnail, "image", `「${o.name}」のサムネイル`);
    for (const s of o.systems) {
      if (isPackageResourceId(s.id)) {
        // ライブラリの System は依存の中身にあるので、今の依存のものかだけを見る（ADR 0015）
        if ((snap.dependencies ?? []).some((d) => belongsToDependency(s.id, d))) continue;
        push({
          code: "output-system-not-in-dependencies",
          severity: "warning",
          subject,
          location: { kind: "property", path: ["systems", s.id] },
          related: [],
          message: `アウトプット「${o.name}」のライブラリの System は、今の依存にありません（版を変えたか、外しました）`,
          detail: `ID: ${s.id}`,
        });
        continue;
      }
      if (!systems.has(s.id))
        push({
          code: "output-system-missing",
          severity: "warning",
          subject,
          location: { kind: "property", path: ["systems", s.id] },
          related: [],
          message: `アウトプット「${o.name}」の System の一つがありません`,
          detail: `ID: ${s.id}`,
        });
    }
    for (const k of o.keep) {
      const e = entities.get(k.entity);
      const field = defs.get(k.koko)?.fields.find((f) => f.id === k.field);
      if (!e || e.output !== o.id || !field || !(k.koko in e.states))
        push({
          code: "keep-invalid",
          severity: "warning",
          subject,
          location: { kind: "property", path: ["keep", k.entity, k.koko, k.field] },
          related: [],
          message: `アウトプット「${o.name}」の状態維持マークが、ない値を指しています`,
        });
    }
  }
  // ライブラリに含めた System は、使う側では同じライブラリに含めたもの・Built-in・そのライブラリの依存しか見えない（ADR 0015・0055）
  let index: ResourcePathIndex | null = null;
  for (const o of snap.outputs) {
    if (o.kind !== "library") continue;
    const included = new Set(o.resources ?? []);
    for (const s of snap.systems) {
      if (!included.has(s.id) || !s.code.includes("import")) continue;
      index ??= ResourcePathIndex.fromSnapshot(snap);
      const compiled = compileSystem(s.id, s.code, index);
      const subject: ResourceRef = { kind: "system", id: s.id };
      for (const b of compiled.bindings) {
        if (isBuiltin(b.resourceId) || included.has(b.resourceId)) continue;
        push({
          code: "exported-system-imports-private",
          severity: "error",
          subject,
          location: { kind: "script", line: b.line, symbol: b.spelling },
          related: [{ kind: "kokostate", id: b.resourceId }],
          message: `ライブラリ「${o.name}」に含めた System「${s.name}」が、含めていない「${b.name}」を import しています（使う側では見つかりません。「${b.name}」もライブラリに含めてください）`,
        });
      }
    }
  }
  return out;
}
