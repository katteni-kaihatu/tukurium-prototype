import type { FieldDef, FieldType, FieldValue, KokoStateDef, Vec3 } from "@tukurium/eks";
import {
  BUILTIN,
  checkProjectReferences,
  checkProjectStructure,
  compileSystem,
  type Diagnostic,
  gunAndTargetSample,
  KOKO_ROLES,
  type PackageDependency,
  type PackageResolution,
  type ProjectDoc,
  ResourcePathIndex,
} from "@tukurium/repo-model";
import { hostApiDeclarations, type LogEntry, Simulation } from "@tukurium/runtime";
import { TypeChecker } from "@tukurium/typecheck";
import { nodeTypeCheckerOptions } from "@tukurium/typecheck/node";
import type { RepoService } from "../repos/service";
import type { AgentClient } from "./AgentClient";

/**
 * MCP の道具の中身（ADR 0054）。エージェントが開いたワークスペースの ProjectDoc を、人の画面と
 * 同じ操作で変える。ここでは MCP に依存しない（mcp.ts が道具として並べる）。
 * KokoState・欄・System・アウトプットは、ID でも名前でも指せる。
 */

export const FIELD_TYPES = [
  "number",
  "boolean",
  "string",
  "vec3",
  "color",
  "entity",
  "texture",
  "material",
  "model",
  "audio",
] as const satisfies readonly FieldType[];

const MAX_SIM_SECONDS = 20;

export class AgentError extends Error {}

export function projectOf(agent: AgentClient): { project: ProjectDoc; workspaceId: string } {
  const w = agent.workspace;
  if (!w) throw new AgentError("ワークスペースを開いていません。open_workspace で開いてください");
  return { project: w.project, workspaceId: w.id };
}

export function writable(agent: AgentClient): ProjectDoc {
  const w = agent.workspace;
  if (!w) throw new AgentError("ワークスペースを開いていません。open_workspace で開いてください");
  if (w.role === "viewer")
    throw new AgentError("このワークスペースは閲覧だけです（共同編集の権限がありません）");
  return w.project;
}

const norm = (s: string) => s.normalize("NFC").toLowerCase();

/** ID か名前で一つに決める。見つからない・曖昧ならエラー */
function pick<T extends { id: string; name: string }>(list: T[], ref: string, what: string): T {
  const byId = list.find((x) => x.id === ref);
  if (byId) return byId;
  const hits = list.filter((x) => norm(x.name) === norm(ref));
  if (hits.length === 1 && hits[0]) return hits[0];
  if (hits.length > 1)
    throw new AgentError(
      `${what}「${ref}」が複数あります。ID で指してください: ${hits.map((h) => h.id).join(", ")}`,
    );
  throw new AgentError(`${what}「${ref}」が見つかりません`);
}

export function kokoOf(project: ProjectDoc, ref: string): KokoStateDef {
  return pick(project.registry().all(), ref, "KokoState");
}

function fieldOf(def: KokoStateDef, ref: string): FieldDef {
  return pick(def.fields, ref, `${def.name} の欄`);
}

function outputOf(project: ProjectDoc, ref: string | undefined) {
  const outputs = project.outputs();
  if (!ref) {
    const first = outputs[0];
    if (!first) throw new AgentError("アウトプットがありません");
    return first;
  }
  return pick(outputs, ref, "アウトプット");
}

function entityOf(project: ProjectDoc, ref: string) {
  return pick(project.entities(), ref, "Entity");
}

/** 欄の型に合わせて値を確かめる（JSON から来るので、形を直せるものは直す） */
function coerce(field: FieldDef, value: unknown): FieldValue {
  const bad = () =>
    new AgentError(
      `欄「${field.name}」（${field.type}）に使えない値です: ${JSON.stringify(value)}`,
    );
  switch (field.type) {
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      throw bad();
    case "boolean":
      if (typeof value === "boolean") return value;
      throw bad();
    case "string":
      if (typeof value === "string") return value;
      throw bad();
    case "color":
      if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
      throw bad();
    case "vec3":
      if (
        Array.isArray(value) &&
        value.length === 3 &&
        value.every((n) => typeof n === "number" && Number.isFinite(n))
      )
        return value as Vec3;
      throw bad();
    default:
      if (value === null || typeof value === "string") return value as FieldValue;
      throw bad();
  }
}

/** { KokoState: { 欄: 値 } } を ID の形にする */
function toStates(
  project: ProjectDoc,
  states: Record<string, Record<string, unknown>>,
): Record<string, Record<string, FieldValue>> {
  const out: Record<string, Record<string, FieldValue>> = {};
  for (const [kokoRef, values] of Object.entries(states)) {
    const def = kokoOf(project, kokoRef);
    const v: Record<string, FieldValue> = {};
    for (const [fieldRef, raw] of Object.entries(values ?? {})) {
      const f = fieldOf(def, fieldRef);
      v[f.id] = coerce(f, raw);
    }
    out[def.id] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 見る

export function overview(project: ProjectDoc) {
  const snap = project.snapshot();
  const index = ResourcePathIndex.fromSnapshot(snap);
  const registry = project.registry();
  const nameOf = (id: string) => registry.get(id)?.name ?? id;
  return {
    name: snap.name,
    outputs: snap.outputs.map((o) => ({
      id: o.id,
      name: o.name,
      kind: o.kind,
      systems: o.systems.map((s) => ({
        id: s.id,
        name: project.system(s.id)?.name ?? s.id,
        enabled: s.enabled,
      })),
      entities: project.entities(o.id).map((e) => ({
        id: e.id,
        name: e.name,
        parent: e.parent,
        kokostates: Object.keys(e.states).map(nameOf),
      })),
    })),
    kokostates: snap.kokostates.map((k) => ({
      id: k.id,
      name: k.name,
      path: index.pathOf(k.id),
      fields: k.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, default: f.default })),
    })),
    builtinKokostates: registry
      .all()
      .filter((k) => k.builtin)
      .map((k) => ({
        id: k.id,
        name: k.name,
        fields: k.fields.map((f) => `${f.name}: ${f.type}`),
      })),
    systems: snap.systems.map((s) => ({ id: s.id, name: s.name, path: index.pathOf(s.id) })),
    materials: snap.materials,
    assets: (snap.assets ?? []).map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
    dependencies: snap.dependencies ?? [],
  };
}

export function entityDetail(project: ProjectDoc, ref: string) {
  const e = entityOf(project, ref);
  const registry = project.registry();
  return {
    id: e.id,
    name: e.name,
    output: e.output,
    parent: e.parent,
    states: Object.fromEntries(
      Object.entries(e.states).map(([koko, values]) => {
        const def = registry.get(koko);
        return [
          def?.name ?? koko,
          Object.fromEntries((def?.fields ?? []).map((f) => [f.name, values[f.id] ?? f.default])),
        ];
      }),
    ),
  };
}

export function systemDetail(project: ProjectDoc, ref: string) {
  const s = pick(project.systems(), ref, "System");
  return { id: s.id, name: s.name, code: project.code(s.id)?.toString() ?? "" };
}

// ---------------------------------------------------------------------------
// 作る・変える

export function createEntity(
  project: ProjectDoc,
  args: {
    name: string;
    output?: string;
    parent?: string | null;
    states?: Record<string, Record<string, unknown>>;
  },
): string {
  const output = outputOf(project, args.output);
  const parent = args.parent ? entityOf(project, args.parent).id : null;
  const states = toStates(project, args.states ?? {});
  return project.addEntity({ output: output.id, name: args.name, parent, states });
}

export function updateEntity(
  project: ProjectDoc,
  args: {
    entity: string;
    name?: string;
    parent?: string | null;
    states?: Record<string, Record<string, unknown>>;
    removeStates?: string[];
  },
): void {
  const e = entityOf(project, args.entity);
  const states = toStates(project, args.states ?? {});
  const remove = (args.removeStates ?? []).map((r) => kokoOf(project, r).id);
  project.transact(() => {
    if (args.name !== undefined) project.renameEntity(e.id, args.name);
    if (args.parent !== undefined)
      project.setParent(e.id, args.parent ? entityOf(project, args.parent).id : null);
    for (const [koko, values] of Object.entries(states)) {
      if (!(koko in (project.entity(e.id)?.states ?? {}))) project.addState(e.id, koko, values);
      else for (const [f, v] of Object.entries(values)) project.setField(e.id, koko, f, v);
    }
    for (const koko of remove) project.removeState(e.id, koko);
  });
}

export function deleteEntity(project: ProjectDoc, ref: string): void {
  project.removeEntity(entityOf(project, ref).id);
}

interface FieldSpec {
  name: string;
  type: FieldType;
  default?: unknown;
}

const DEFAULTS: Record<FieldType, FieldValue> = {
  number: 0,
  boolean: false,
  string: "",
  vec3: [0, 0, 0],
  color: "#ffffff",
  entity: null,
  texture: null,
  material: null,
  model: null,
  audio: null,
};

/** 欄の定義を作る。同じ名前の欄があれば、その ID を引き継ぐ（値が切れないように） */
function toFields(specs: FieldSpec[], prev: FieldDef[] = []): FieldDef[] {
  return specs.map((s) => {
    const id =
      prev.find((p) => norm(p.name) === norm(s.name))?.id ??
      `f_${s.name.replace(/[^A-Za-z0-9_]/g, "") || "field"}_${Math.random().toString(36).slice(2, 6)}`;
    const base = { id, name: s.name, type: s.type, default: DEFAULTS[s.type] } as FieldDef;
    return { ...base, default: s.default === undefined ? base.default : coerce(base, s.default) };
  });
}

export function createKokoState(
  project: ProjectDoc,
  args: { name: string; fields: FieldSpec[]; role?: string },
): string {
  const id = project.addKokoState(args.name);
  const def = project.kokostate(id);
  if (!def) throw new AgentError("KokoState を作れませんでした");
  project.updateKokoState({
    ...def,
    fields: toFields(args.fields),
    ...(args.role ? { role: args.role } : {}),
  });
  return id;
}

export function updateKokoState(
  project: ProjectDoc,
  args: { kokostate: string; name?: string; fields?: FieldSpec[]; role?: string },
): void {
  const def = kokoOf(project, args.kokostate);
  if (def.builtin) throw new AgentError("Built-in の KokoState は変えられません");
  project.updateKokoState({
    ...def,
    name: args.name ?? def.name,
    fields: args.fields ? toFields(args.fields, def.fields) : def.fields,
    ...(args.role !== undefined ? { role: args.role } : {}),
  });
}

export function createSystem(
  project: ProjectDoc,
  args: { name: string; code: string; output?: string; enable?: boolean },
): string {
  const id = project.addSystem(args.name, args.code);
  if (args.enable !== false) {
    const output = outputOf(project, args.output);
    project.updateOutput({ ...output, systems: [...output.systems, { id, enabled: true }] });
  }
  return id;
}

export function updateSystem(
  project: ProjectDoc,
  args: { system: string; code?: string; name?: string },
): void {
  const s = pick(project.systems(), args.system, "System");
  project.transact(() => {
    if (args.name !== undefined) project.renameSystem(s.id, args.name);
    if (args.code !== undefined) {
      const text = project.code(s.id);
      if (!text) throw new AgentError("System のコードが見つかりません");
      text.delete(0, text.length);
      text.insert(0, args.code);
    }
  });
}

export function setOutputSystems(
  project: ProjectDoc,
  args: { output?: string; systems: { system: string; enabled?: boolean }[] },
): void {
  const output = outputOf(project, args.output);
  const systems = args.systems.map((s) => ({
    id: pick(project.systems(), s.system, "System").id,
    enabled: s.enabled !== false,
  }));
  project.updateOutput({ ...output, systems });
}

export function createMaterial(
  project: ProjectDoc,
  args: { name: string; color?: string; roughness?: number; metalness?: number },
): string {
  return project.addMaterial(args.name, {
    ...(args.color ? { color: args.color } : {}),
    ...(args.roughness !== undefined ? { roughness: args.roughness } : {}),
    ...(args.metalness !== undefined ? { metalness: args.metalness } : {}),
  });
}

// ---------------------------------------------------------------------------
// 確かめる

/** 依存のライブラリの中身（エージェントの利用者の許可で取り出す。クライアントと同じ形） */
export async function resolvePackages(
  repos: RepoService | null,
  user: { id: string } | null,
  deps: readonly PackageDependency[],
): Promise<{ direct: Map<string, PackageResolution>; pool: PackageResolution[] }> {
  const direct = new Map<string, PackageResolution>();
  const below: PackageResolution[] = [];
  for (const dep of deps) {
    try {
      if (!repos) throw new Error("ライブラリを取り出せません");
      const got = await repos.packageVersion(user, dep.packageId, dep.version);
      if (got.contentHash !== dep.contentHash) {
        direct.set(dep.alias, {
          status: "unavailable",
          dependency: dep,
          message: `v${dep.version} の中身が、足したときと違います`,
        });
        continue;
      }
      direct.set(dep.alias, { status: "ready", dependency: dep, manifest: got.manifest });
      below.push(...got.dependencies);
    } catch (e) {
      direct.set(dep.alias, {
        status: "unavailable",
        dependency: dep,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { direct, pool: [...direct.values(), ...below] };
}

const showDiagnostic = (d: Diagnostic) => ({
  severity: d.severity,
  code: d.code,
  message: d.message,
  subject: d.subject,
  ...(d.location ? { location: d.location } : {}),
  ...(d.detail ? { detail: d.detail } : {}),
});

/** スクリプトの型を確かめる（ADR 0058）。TypeScript の本体は重いので、初めて使うときに作り、使い回す */
let typeChecker: TypeChecker | null = null;
const HOST_DECLARATIONS = hostApiDeclarations();

/**
 * 作っている途中の問題：構造・参照・System の書き方と import・型の誤り
 * （スクリプトの実行時の問題は simulate で）。型の誤りがあっても simulate は動く。
 */
export async function check(
  project: ProjectDoc,
  packages: Map<string, PackageResolution>,
): Promise<ReturnType<typeof showDiagnostic>[]> {
  const snap = project.snapshot();
  const index = ResourcePathIndex.fromSnapshot(snap);
  const out: Diagnostic[] = [
    ...checkProjectStructure(snap, index),
    ...checkProjectReferences(snap),
  ];
  for (const s of snap.systems) {
    const compiled = compileSystem(s.id, s.code, index, packages);
    if (!compiled.ok) out.push(...compiled.diagnostics);
  }
  typeChecker ??= new TypeChecker(nodeTypeCheckerOptions());
  out.push(...typeChecker.check({ snapshot: snap, packages, hostDeclarations: HOST_DECLARATIONS }));
  return out.map(showDiagnostic);
}

export interface SimInput {
  at: number;
  action: string;
  phase?: "down" | "up";
  origin?: Vec3;
  direction?: Vec3;
}

/**
 * 試しに動かす：アウトプットを、手元（サーバー）の Simulation で決まった時間だけ動かし、
 * System の状態（止まった理由）・ログ・Entity の状態を返す。人の再生（Play）とは別で、誰にも見えない。
 */
export async function simulate(
  project: ProjectDoc,
  workspaceId: string,
  pool: PackageResolution[],
  args: {
    output?: string;
    seconds?: number;
    inputs?: SimInput[];
    watch?: string[];
    equip?: string[];
  },
) {
  const output = outputOf(project, args.output);
  const seconds = Math.min(Math.max(args.seconds ?? 2, 0), MAX_SIM_SECONDS);
  const logs: LogEntry[] = [];
  const sim = await Simulation.create(project.snapshot(), output.id, {
    realm: `agent:${workspaceId}`,
    onLog: (l) => logs.push(l),
    packages: pool,
  });
  try {
    // 道具（EquipmentTool）を、始める前にエージェントが装備する（撃つなどの入力は装備した道具に届く）
    for (const ref of args.equip ?? []) {
      const id = entityOf(project, ref).id;
      const tool = sim.world.get(id, BUILTIN.EquipmentTool);
      if (!tool) throw new AgentError(`「${ref}」は道具（EquipmentTool）ではありません`);
      tool.player = "agent";
    }
    const dt = 1 / 60;
    const inputs = [...(args.inputs ?? [])].sort((a, b) => a.at - b.at);
    const frames = Math.round(seconds / dt);
    for (let i = 0; i < frames; i++) {
      const t = i * dt;
      while (inputs[0] && inputs[0].at <= t) {
        const ev = inputs.shift() as SimInput;
        sim.input({
          action: ev.action,
          phase: ev.phase ?? "down",
          origin: ev.origin ?? [0, 1.6, 0],
          direction: ev.direction ?? [0, 0, -1],
          player: "agent",
          playerName: "エージェント",
        });
      }
      sim.step(dt);
    }
    const registry = project.registry();
    const watch = args.watch?.map((r) => entityOf(project, r).id);
    const entities = project
      .entities(output.id)
      .filter((e) => !watch || watch.includes(e.id))
      .slice(0, 60)
      .map((e) => ({
        id: e.id,
        name: e.name,
        states: Object.fromEntries(
          sim.world.statesOf(e.id).map((koko) => {
            const def = registry.get(koko);
            const values = sim.world.get(e.id, koko) ?? {};
            return [
              def?.name ?? koko,
              Object.fromEntries((def?.fields ?? []).map((f) => [f.name, values[f.id]])),
            ];
          }),
        ),
      }));
    return {
      output: output.name,
      seconds,
      systems: sim.systemStatus(),
      logs: logs.slice(-50),
      entities,
    };
  } finally {
    sim.dispose();
  }
}

// ---------------------------------------------------------------------------
// 手引き

export function guide(): string {
  const sample = gunAndTargetSample();
  const shoot = sample.systems.find((s) => s.name === "Shoot")?.code ?? "";
  return [
    "# Tukurium で作るための手引き（エージェント向け）",
    "",
    "## 考え方",
    "- プロジェクトは、アウトプット（アイテム・ワールド・ライブラリ）と、その中の Entity の木でできている。",
    "- Entity には KokoState（続く状態。欄を持つ）を付ける。Transform・Mesh・Collider などは Built-in。",
    "- 動きは System（TypeScript）で書く。System はアウトプットに入れて有効にすると動く。",
    '- KokoState は import して使う（例：import Gun from "./Gun.koko";、Built-in は @builtin/Transform.koko、ライブラリは @別名/...）。Query の with・without にも import した値を書く（"Gun" のような名前の文字列は使えない）。',
    "- Entity の値は e.get(Gun) で読み書きする。e.get() に渡せるのは、その System の query.with に書いた KokoState だけ。",
    "- 型の判定は厳しい（TypeScript の strict）。check が型の誤りも返す（出どころ types）。型の誤りがあっても simulate は動くが、直してから人に渡す。",
    "- 変更は、人の画面にそのまま届く。保存（コミット）は人が行う。エージェントは保存できない。",
    "",
    "## 進め方のおすすめ",
    "1. get_project で全体を見る。",
    "2. 足りない KokoState を create_kokostate で作り、create_entity で Entity を作る。",
    "3. create_system で System を書く（既定でアウトプットに入り、有効になる）。",
    "4. check で問題を確かめ、simulate で試しに動かしてログと状態を見る。",
    "   - 銃などの道具（EquipmentTool）への入力（fire など）は、装備した人にだけ届く。simulate の equip に道具の Entity を渡すと、エージェントが装備した状態で始まる。",
    "5. 終わったら、人に「保存してください」と伝える。",
    "",
    `## KokoState の役割（role）: ${KOKO_ROLES.map((r) => `${r.id}=${r.label}`).join(", ")}`,
    `## 欄の型: ${FIELD_TYPES.join(", ")}`,
    "",
    "## System の書き方（見本：サンプル「銃と的」の Shoot）",
    "```ts",
    shoot.trim(),
    "```",
    "",
    "## Host API（System から使える world.* などの型）",
    "```ts",
    hostApiDeclarations(),
    "```",
  ].join("\n");
}
