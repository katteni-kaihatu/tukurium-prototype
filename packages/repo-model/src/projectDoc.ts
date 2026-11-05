import type {
  EntityId,
  FieldValue,
  KokoStateDef,
  KokoStateId,
  KokoStateValues,
} from "@tukurium/eks";
import * as Y from "yjs";
import { BUILTIN_KOKOSTATES, buildRegistry, isBuiltin } from "./builtins";
import { validateAlias } from "./packageDependency";
import { normalizeName, validateName } from "./resourcePath";
import {
  type AssetDef,
  type EntityDef,
  type FolderDef,
  type MaterialDef,
  newId,
  type OutputDef,
  type OutputKind,
  type PackageDependency,
  type ProjectSnapshot,
  type SystemDef,
} from "./schema";
import { planImportRefactor } from "./systemCompiler";

const clone = <T>(v: T): T => structuredClone(v);

/**
 * ワークスペースの制作データ（編集中）。Y.Doc の上に載せ、共同編集でそのまま同期できるようにする。
 *
 * 構造：
 * - meta        : Y.Map            name
 * - kokostates  : Y.Map<KokoStateDef>   利用者定義（Built-in は含めない）
 * - systems     : Y.Map<SystemDef>
 * - code        : Y.Map<Y.Text>         System のスクリプト（文字単位で共同編集）
 * - materials   : Y.Map<MaterialDef>
 * - outputs     : Y.Map<OutputDef>
 * - entities    : Y.Map<Y.Map>          id, name, parent, output, order, states(Y.Map<Y.Map<FieldValue>>)
 *
 * 変更はすべて transact でまとめ、利用者の 1 操作が 1 つの更新になるようにする。
 */
export class ProjectDoc {
  readonly doc: Y.Doc;
  /**
   * 依存から取り込んだ KokoState の定義（ADR 0015）。各クライアントが依存の中身から作る派生データで、
   * Y.Doc には入れない（同期も保存もしない）。Entity に付けたり、Inspector で値を入れたりするために使う。
   */
  private packageDefs: KokoStateDef[] = [];

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
  }

  private get meta() {
    return this.doc.getMap<string>("meta");
  }
  private get kokoMap() {
    return this.doc.getMap<KokoStateDef>("kokostates");
  }
  private get systemMap() {
    return this.doc.getMap<SystemDef>("systems");
  }
  private get codeMap() {
    return this.doc.getMap<Y.Text>("code");
  }
  private get materialMap() {
    return this.doc.getMap<MaterialDef>("materials");
  }
  private get assetMap() {
    return this.doc.getMap<AssetDef>("assets");
  }
  private get folderMap() {
    return this.doc.getMap<FolderDef>("folders");
  }
  /** リソース ID → フォルダ ID */
  private get placementMap() {
    return this.doc.getMap<string>("placement");
  }
  /** 公開の印（リソース ID → true。ADR 0015） */
  private get exportMap() {
    return this.doc.getMap<boolean>("exports");
  }
  /** 使うライブラリ（別名 → 依存。ADR 0015） */
  private get dependencyMap() {
    return this.doc.getMap<PackageDependency>("dependencies");
  }
  private get outputMap() {
    return this.doc.getMap<OutputDef>("outputs");
  }
  private get entityMap() {
    return this.doc.getMap<Y.Map<unknown>>("entities");
  }

  transact(fn: () => void, origin: unknown = "local"): void {
    this.doc.transact(fn, origin);
  }

  /** 変更を購読する。戻り値で解除。 */
  observe(fn: (origin: unknown) => void): () => void {
    const handler = (_u: Uint8Array, origin: unknown) => fn(origin);
    this.doc.on("update", handler);
    return () => this.doc.off("update", handler);
  }

  // ---------- 名前 ----------
  get name(): string {
    return this.meta.get("name") ?? "untitled";
  }
  setName(name: string): void {
    this.meta.set("name", name);
  }

  // ---------- KokoState 定義 ----------
  kokostates(): KokoStateDef[] {
    return [...this.kokoMap.values()].map(clone);
  }
  kokostate(id: KokoStateId): KokoStateDef | undefined {
    const d = this.kokoMap.get(id);
    return d ? clone(d) : undefined;
  }
  registry() {
    return buildRegistry([...this.kokostates(), ...this.packageDefs]);
  }
  /** 依存から取り込んだ KokoState の定義を入れ替える（packageKokoStates の結果） */
  setPackageKokoStates(defs: readonly KokoStateDef[]): void {
    this.packageDefs = defs.map(clone);
  }
  packageKokoStates(): KokoStateDef[] {
    return this.packageDefs.map(clone);
  }
  addKokoState(name: string): KokoStateId {
    this.assertKokoName(name, null);
    const id = newId("ks");
    this.kokoMap.set(id, { id, name, fields: [] });
    return id;
  }
  /** 定義を書き換える。フィールドを消した・型を変えた場合、Entity の値も合わせる。 */
  updateKokoState(def: KokoStateDef): void {
    const renamed = this.kokoMap.get(def.id)?.name !== def.name;
    if (renamed) this.refactoring(() => this.updateKokoStateNow(def));
    else this.updateKokoStateNow(def);
  }
  private updateKokoStateNow(def: KokoStateDef): void {
    if (isBuiltin(def.id)) throw new Error("Built-in の KokoState は変更できません");
    this.assertKokoName(def.name, def.id);
    const ids = new Set<string>();
    for (const f of def.fields) {
      if (ids.has(f.id)) throw new Error(`フィールド ID が重複しています: ${f.id}`);
      ids.add(f.id);
    }
    const names = def.fields.map((f) => f.name);
    if (new Set(names).size !== names.length) throw new Error("フィールド名が重複しています");
    this.transact(() => {
      const prev = this.kokoMap.get(def.id);
      this.kokoMap.set(def.id, clone(def));
      if (!prev) return;
      // Entity が持っている値を新しい定義に合わせる（消えたフィールドは削除、型が変わったら初期値）
      for (const e of this.entityMap.values()) {
        const states = e.get("states") as Y.Map<Y.Map<FieldValue>>;
        const values = states.get(def.id);
        if (!values) continue;
        for (const field of values.keys()) if (!ids.has(field)) values.delete(field);
        for (const f of def.fields) {
          const old = prev.fields.find((p) => p.id === f.id);
          if (!old || old.type !== f.type || !values.has(f.id)) values.set(f.id, clone(f.default));
        }
      }
    });
  }
  removeKokoState(id: KokoStateId): void {
    this.transact(() => {
      this.kokoMap.delete(id);
      for (const e of this.entityMap.values()) (e.get("states") as Y.Map<unknown>).delete(id);
    });
  }
  private assertKokoName(name: string, self: KokoStateId | null): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("KokoState の名前は英字で始まる英数字と _ にしてください");
    }
    // Built-in と同じ名前は、移行の間の名前での書き方（with: ["Transform"]）が曖昧になるので拒む
    if (BUILTIN_KOKOSTATES.some((b) => b.name === name))
      throw new Error(`名前「${name}」は Built-in の KokoState が使っています`);
    // 名前はプロジェクト全体で一つでなくてよい（同一性は ID。ADR 0010）。同じ場所の中だけで一つにする
    if (self !== null && this.kokoMap.get(self)?.name !== name) this.assertSiblingName(name, self);
  }

  // ---------- System ----------
  systems(): SystemDef[] {
    return [...this.systemMap.values()].map(clone);
  }
  system(id: string): SystemDef | undefined {
    const s = this.systemMap.get(id);
    return s ? clone(s) : undefined;
  }
  code(id: string): Y.Text | undefined {
    return this.codeMap.get(id);
  }
  addSystem(name: string, code: string): string {
    const id = newId("sys");
    this.transact(() => {
      this.systemMap.set(id, { id, name });
      const text = new Y.Text();
      text.insert(0, code);
      this.codeMap.set(id, text);
    });
    return id;
  }
  renameSystem(id: string, name: string): void {
    const s = this.systemMap.get(id);
    if (!s || s.name === name) return;
    this.assertSiblingName(name, id);
    this.systemMap.set(id, { ...s, name });
  }
  removeSystem(id: string): void {
    this.transact(() => {
      this.systemMap.delete(id);
      this.codeMap.delete(id);
      for (const o of this.outputMap.values()) {
        if (o.systems.some((s) => s.id === id)) {
          this.outputMap.set(o.id, { ...o, systems: o.systems.filter((s) => s.id !== id) });
        }
      }
    });
  }

  // ---------- マテリアル ----------
  materials(): MaterialDef[] {
    return [...this.materialMap.values()].map(clone);
  }
  material(id: string): MaterialDef | undefined {
    const m = this.materialMap.get(id);
    return m ? clone(m) : undefined;
  }
  addMaterial(name: string, init: Partial<Omit<MaterialDef, "id" | "name">> = {}): string {
    const id = newId("mat");
    this.materialMap.set(id, { id, name, color: "#d8d2c6", roughness: 0.6, metalness: 0, ...init });
    return id;
  }
  updateMaterial(m: MaterialDef): void {
    const prev = this.materialMap.get(m.id);
    if (prev && prev.name !== m.name) this.assertSiblingName(m.name, m.id);
    this.materialMap.set(m.id, clone(m));
  }
  removeMaterial(id: string): void {
    this.transact(() => {
      this.materialMap.delete(id);
      for (const e of this.entityMap.values()) {
        const states = e.get("states") as Y.Map<Y.Map<FieldValue>>;
        const mesh = states.get("builtin.Mesh");
        if (mesh?.get("material") === id) mesh.set("material", null);
      }
    });
  }

  // ---------- 素材 ----------
  assets(): AssetDef[] {
    return [...this.assetMap.values()].map(clone);
  }
  asset(id: string): AssetDef | undefined {
    const a = this.assetMap.get(id);
    return a ? clone(a) : undefined;
  }
  /** 素材を加える（同じ中身はすでにあれば名前だけ更新） */
  addAsset(a: AssetDef): void {
    this.assetMap.set(a.id, clone(a));
  }
  removeAsset(id: string): void {
    this.transact(() => {
      this.assetMap.delete(id);
      for (const m of this.materialMap.values()) {
        if (m.map === id) this.materialMap.set(m.id, { ...m, map: null });
      }
      for (const e of this.entityMap.values()) {
        const states = e.get("states") as Y.Map<Y.Map<FieldValue>>;
        for (const values of states.values()) {
          for (const [field, value] of values) if (value === id) values.set(field, null);
        }
      }
    });
  }

  // ---------- アウトプット ----------
  outputs(): OutputDef[] {
    return [...this.outputMap.values()].map(clone);
  }
  output(id: string): OutputDef | undefined {
    const o = this.outputMap.get(id);
    return o ? clone(o) : undefined;
  }
  addOutput(name: string, kind: OutputKind): string {
    const id = newId("out");
    this.outputMap.set(id, { id, name, kind, systems: [], keep: [] });
    return id;
  }
  updateOutput(o: OutputDef): void {
    this.outputMap.set(o.id, clone(o));
  }

  // ---------- Entity ----------
  entities(output?: string): EntityDef[] {
    const out: EntityDef[] = [];
    for (const e of this.entityMap.values()) {
      const def = this.toEntityDef(e);
      if (output === undefined || def.output === output) out.push(def);
    }
    return out.sort((a, b) => a.order - b.order);
  }
  entity(id: EntityId): EntityDef | undefined {
    const e = this.entityMap.get(id);
    return e ? this.toEntityDef(e) : undefined;
  }
  addEntity(init: {
    output: string;
    name: string;
    parent?: EntityId | null;
    states?: Record<KokoStateId, KokoStateValues>;
    id?: EntityId;
  }): EntityId {
    const id = init.id ?? newId("ent");
    const registry = this.registry();
    this.transact(() => {
      const e = new Y.Map<unknown>();
      const siblings = this.entities(init.output).filter((s) => s.parent === (init.parent ?? null));
      e.set("id", id);
      e.set("name", init.name);
      e.set("parent", init.parent ?? null);
      e.set("output", init.output);
      e.set("order", siblings.length === 0 ? 0 : Math.max(...siblings.map((s) => s.order)) + 1);
      const states = new Y.Map<Y.Map<FieldValue>>();
      for (const [koko, values] of Object.entries(init.states ?? {})) {
        states.set(
          koko,
          new Y.Map<FieldValue>(Object.entries(registry.createValues(koko, values))),
        );
      }
      e.set("states", states);
      this.entityMap.set(id, e);
    });
    return id;
  }
  renameEntity(id: EntityId, name: string): void {
    this.entityMap.get(id)?.set("name", name);
  }
  setParent(id: EntityId, parent: EntityId | null): void {
    // 自分の子孫を親にはできない
    for (let p = parent; p !== null; p = this.entity(p)?.parent ?? null) {
      if (p === id) throw new Error("自分の子孫を親にはできません");
    }
    this.entityMap.get(id)?.set("parent", parent);
  }
  /** Entity を削除する（子も削除）。状態維持のマークも外す。 */
  removeEntity(id: EntityId): void {
    this.transact(() => {
      const ids = this.descendants(id);
      for (const eid of ids) this.entityMap.delete(eid);
      for (const o of this.outputMap.values()) {
        if (o.keep.some((k) => ids.includes(k.entity))) {
          this.outputMap.set(o.id, { ...o, keep: o.keep.filter((k) => !ids.includes(k.entity)) });
        }
      }
    });
  }
  addState(id: EntityId, koko: KokoStateId, values?: KokoStateValues): void {
    const states = this.statesOf(id);
    if (states.has(koko)) return;
    states.set(
      koko,
      new Y.Map<FieldValue>(Object.entries(this.registry().createValues(koko, values))),
    );
  }
  removeState(id: EntityId, koko: KokoStateId): void {
    this.statesOf(id).delete(koko);
  }
  /** フィールドの値を変える（他のフィールドはそのまま）。 */
  setField(id: EntityId, koko: KokoStateId, field: string, value: FieldValue): void {
    const states = this.statesOf(id);
    const values = states.get(koko);
    if (!values) throw new Error(`Entity ${id} は ${koko} を持っていません`);
    values.set(field, clone(value));
  }

  // ---------- 丸ごと ----------
  snapshot(): ProjectSnapshot {
    const resources = new Set([
      ...this.kokostates().map((k) => k.id),
      ...this.systems().map((x) => x.id),
      ...this.materials().map((m) => m.id),
      ...this.assets().map((a) => a.id),
    ]);
    const folders = this.folders();
    const folderIds = new Set(folders.map((f) => f.id));
    // 消えたリソース・消えたフォルダへの割り当ては残さない
    const placement = Object.fromEntries(
      [...this.placementMap.entries()].filter(([r, f]) => resources.has(r) && folderIds.has(f)),
    );
    return {
      version: 1,
      name: this.name,
      kokostates: this.kokostates(),
      systems: this.systems().map((s) => ({ ...s, code: this.code(s.id)?.toString() ?? "" })),
      materials: this.materials(),
      assets: this.assets(),
      outputs: this.outputs(),
      entities: this.entities(),
      provenance: clone(
        (this.meta.get("provenance") as unknown as ProjectSnapshot["provenance"]) ?? [],
      ),
      folders,
      placement,
      exports: [...this.exportMap.keys()].filter((r) => resources.has(r)).sort(),
      dependencies: this.dependencies(),
    };
  }

  /** 中身を丸ごと置き換える（サンプルの読み込み、コミットからの復元など）。 */
  load(snap: ProjectSnapshot): void {
    this.transact(() => {
      for (const m of [
        this.kokoMap,
        this.systemMap,
        this.codeMap,
        this.materialMap,
        this.assetMap,
        this.outputMap,
        this.entityMap,
        this.folderMap,
        this.placementMap,
        this.exportMap,
        this.dependencyMap,
      ]) {
        m.clear();
      }
      for (const f of snap.folders ?? []) this.folderMap.set(f.id, clone(f));
      for (const [r, f] of Object.entries(snap.placement ?? {})) this.placementMap.set(r, f);
      for (const r of snap.exports ?? []) this.exportMap.set(r, true);
      for (const d of snap.dependencies ?? []) this.dependencyMap.set(d.alias, clone(d));
      this.meta.set("name", snap.name);
      this.meta.set("provenance", (snap.provenance ?? []) as unknown as string);
      for (const k of snap.kokostates) this.kokoMap.set(k.id, clone(k));
      for (const s of snap.systems) {
        this.systemMap.set(s.id, { id: s.id, name: s.name });
        const text = new Y.Text();
        text.insert(0, s.code);
        this.codeMap.set(s.id, text);
      }
      for (const m of snap.materials) this.materialMap.set(m.id, clone(m));
      for (const a of snap.assets ?? []) this.assetMap.set(a.id, clone(a));
      for (const o of snap.outputs) this.outputMap.set(o.id, clone(o));
      for (const e of snap.entities) {
        const map = new Y.Map<unknown>();
        map.set("id", e.id);
        map.set("name", e.name);
        map.set("parent", e.parent);
        map.set("output", e.output);
        map.set("order", e.order);
        const states = new Y.Map<Y.Map<FieldValue>>();
        for (const [k, v] of Object.entries(e.states))
          states.set(k, new Y.Map<FieldValue>(Object.entries(clone(v))));
        map.set("states", states);
        this.entityMap.set(e.id, map);
      }
    });
  }

  // ---------- Resources のフォルダ ----------

  folders(): FolderDef[] {
    return [...this.folderMap.values()].map(clone).sort((a, b) => a.name.localeCompare(b.name));
  }

  addFolder(name: string, parent: string | null): string {
    const id = newId("fld");
    this.folderMap.set(id, { id, name: name.trim() || "新しいフォルダ", parent });
    return id;
  }

  renameFolder(id: string, name: string): void {
    const f = this.folderMap.get(id);
    const next = name.trim();
    if (!f || !next || f.name === next) return;
    this.assertSiblingName(next, id);
    this.refactoring(() => this.folderMap.set(id, { ...f, name: next }));
  }

  /**
   * 名前の変更・移動をして、import のパスを新しい場所に合わせて書き直す（ADR 0010 §3）。
   * 変更と書き直しは一つの transaction にする（共同編集の相手にも一度に届く）。
   */
  private refactoring(change: () => void): void {
    const prev = this.snapshot();
    this.transact(() => {
      change();
      const edits = planImportRefactor(prev, this.snapshot()).sort((a, b) => b.start - a.start);
      for (const e of edits) {
        const text = this.codeMap.get(e.systemId);
        if (!text) continue;
        text.delete(e.start, e.end - e.start);
        text.insert(e.start, e.text);
      }
    });
  }

  /** フォルダ・リソースが入っている親（フォルダは親のフォルダ、リソースは置き場所） */
  private parentOf(id: string): string | null {
    const f = this.folderMap.get(id);
    if (f) return f.parent && this.folderMap.has(f.parent) ? f.parent : null;
    return this.folderOf(id);
  }

  /** 親の直下にあるフォルダとリソース（Built-in の KokoState は除く） */
  private siblingsIn(parent: string | null): { id: string; name: string }[] {
    const out: { id: string; name: string }[] = [];
    for (const f of this.folderMap.values()) if (this.parentOf(f.id) === parent) out.push(f);
    const resources: { id: string; name: string }[] = [
      ...this.kokoMap.values(),
      ...this.systemMap.values(),
      ...this.materialMap.values(),
      ...this.assetMap.values(),
    ];
    for (const r of resources) if (this.folderOf(r.id) === parent) out.push(r);
    return out;
  }

  /**
   * 同じ親の直下で、その名前がほかのもの（self 以外）に使われているか。
   * 種類をまたいで比べ、NFC・大文字小文字の違いは同じとみなす（ADR 0010）。
   */
  siblingNameTaken(name: string, parent: string | null, self?: string): boolean {
    const key = normalizeName(name.trim());
    return this.siblingsIn(parent).some((s) => s.id !== self && normalizeName(s.name) === key);
  }

  /** 親の直下で空いている名前（「名前」「名前 2」…）。format で番号の付け方を変えられる */
  freeName(
    base: string,
    parent: string | null,
    format: (base: string, n: number) => string = (b, n) => (n === 1 ? b : `${b} ${n}`),
  ): string {
    const taken = new Set(this.siblingsIn(parent).map((s) => normalizeName(s.name)));
    for (let n = 1; ; n++) {
      const name = format(base, n);
      if (!taken.has(normalizeName(name))) return name;
    }
  }

  /** 名前を変えるときの検査：使えない名前・同じ親の直下での衝突を拒む */
  private assertSiblingName(name: string, self: string): void {
    const problem = validateName(name);
    if (problem) throw new Error(`名前「${name}」は使えません`);
    if (this.siblingNameTaken(name, this.parentOf(self), self))
      throw new Error(`同じ場所に「${name.trim()}」という名前があります`);
  }

  /** フォルダを消す。中のフォルダとリソースは、ひとつ上へ移す */
  removeFolder(id: string): void {
    const f = this.folderMap.get(id);
    if (!f) return;
    this.refactoring(() => {
      for (const c of this.folderMap.values())
        if (c.parent === id) this.folderMap.set(c.id, { ...c, parent: f.parent });
      for (const [r, fid] of this.placementMap.entries()) {
        if (fid !== id) continue;
        if (f.parent) this.placementMap.set(r, f.parent);
        else this.placementMap.delete(r);
      }
      this.folderMap.delete(id);
    });
  }

  /** フォルダを別のフォルダへ移す（自分の中へは移せない） */
  moveFolder(id: string, parent: string | null): void {
    const f = this.folderMap.get(id);
    if (!f) return;
    for (let p = parent; p; p = this.folderMap.get(p)?.parent ?? null) if (p === id) return;
    this.refactoring(() => this.folderMap.set(id, { ...f, parent }));
  }

  /** 公開の印を付ける・外す（ライブラリとして、ほかのプロジェクトから import できる。ADR 0015） */
  setExported(resourceId: string, exported: boolean): void {
    if (exported) this.exportMap.set(resourceId, true);
    else this.exportMap.delete(resourceId);
  }

  isExported(resourceId: string): boolean {
    return this.exportMap.get(resourceId) === true;
  }

  // ---------- 依存（ADR 0015） ----------
  /** 使うライブラリ（別名の順） */
  dependencies(): PackageDependency[] {
    return [...this.dependencyMap.values()]
      .map(clone)
      .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  }

  /**
   * ライブラリを使う。版と content hash を固定する。同じライブラリの別の版は、別の別名で共存できる
   * （ID が版で区切られているので、ぶつからない。混ざっていることは注意で知らせる）
   */
  addDependency(dep: PackageDependency): void {
    const problem = validateAlias(dep.alias);
    if (problem) throw new Error(problem);
    if (this.dependencyMap.has(dep.alias))
      throw new Error(`別名「${dep.alias}」はもう使われています`);
    for (const d of this.dependencyMap.values())
      if (d.packageId === dep.packageId && d.version === dep.version)
        throw new Error(`このライブラリの v${dep.version} はもう「@${d.alias}」で使っています`);
    this.dependencyMap.set(dep.alias, clone(dep));
  }

  removeDependency(alias: string): void {
    this.dependencyMap.delete(alias);
  }

  /** リソースが入っているフォルダ（null はいちばん上） */
  folderOf(resourceId: string): string | null {
    const f = this.placementMap.get(resourceId);
    return f && this.folderMap.has(f) ? f : null;
  }

  /** リソースをフォルダへ移す（null はいちばん上） */
  moveResource(resourceId: string, folder: string | null): void {
    const target = folder && this.folderMap.has(folder) ? folder : null;
    if (this.folderOf(resourceId) === target) return;
    this.refactoring(() => {
      if (target) this.placementMap.set(resourceId, target);
      else this.placementMap.delete(resourceId);
    });
  }

  private descendants(id: EntityId): EntityId[] {
    const all = this.entities();
    const out = [id];
    for (let i = 0; i < out.length; i++) {
      for (const e of all) if (e.parent === out[i]) out.push(e.id);
    }
    return out;
  }

  private statesOf(id: EntityId): Y.Map<Y.Map<FieldValue>> {
    const e = this.entityMap.get(id);
    if (!e) throw new Error(`Unknown entity: ${id}`);
    return e.get("states") as Y.Map<Y.Map<FieldValue>>;
  }

  private toEntityDef(e: Y.Map<unknown>): EntityDef {
    const states = e.get("states") as Y.Map<Y.Map<FieldValue>>;
    return {
      id: e.get("id") as string,
      name: e.get("name") as string,
      parent: (e.get("parent") as string | null) ?? null,
      output: e.get("output") as string,
      order: (e.get("order") as number) ?? 0,
      states: clone(states.toJSON() as Record<KokoStateId, KokoStateValues>),
    };
  }
}
