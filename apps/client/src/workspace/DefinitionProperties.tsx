import type { FieldDef, KokoStateDef } from "@tukurium/eks";
import {
  type GuestPolicy,
  inferCapabilities,
  isPackageResourceId,
  KOKO_ROLES,
  newId,
  type OutputDef,
  type OutputExposure,
  type OutputSystem,
  type PrefabEditPlace,
  packageSystems,
  packageTypeDefs,
  parsePackageResourceId,
  ResourcePathIndex,
  usersOf,
} from "@tukurium/repo-model";
import { createContext, type ReactNode, useContext, useState } from "react";
import {
  formatBytes,
  type ImageInfo,
  ImagePreview,
  MaterialPreview,
  type ModelInfo,
  ModelPreview,
  useAssetFile,
} from "./AssetPreview";
import { ChangeMark, type ChangeTarget, MarkedLine } from "./ChangeMark";
import type { ChangeKind } from "./changeMarks";
import {
  kokoChange,
  materialChange,
  outputChange,
  prefabChange,
  systemChange,
  typeDefChange,
} from "./changeMarks";
import { FieldInput } from "./FieldInput";
import { useCanEdit, useExpanded, useProject } from "./hooks";
import { KokoFieldRow } from "./KokoFieldRow";
import { problemKind, problemPlace } from "./ProblemsPanel";
import { type DetailTarget, useWorkspace } from "./store";
import { ThumbnailField } from "./ThumbnailField";
import ui from "./ui.module.css";
import { useDependencyGraph, useProblems, useSystemQuery } from "./useProblems";
import { useSavedFiles } from "./useSavedFiles";

/** 開いている KokoState・マテリアル・スクリプト・素材・フォルダの詳細 */
export function DetailPanel() {
  const detail = useWorkspace((s) => s.detail);
  if (!detail) return null;
  return <DefinitionProperties selection={detail} />;
}

/**
 * 詳細を出している場所を閉じる（削除したときなど）。ふつうは詳細パネル、
 * Resources の付属パネル（ADR 0044）の中では、その付属パネルの中身を空にする。
 */
const CloseDetail = createContext<() => void>(() => useWorkspace.getState().closeDetail());
const useCloseDetail = () => useContext(CloseDetail);

/** Resources の付属パネル「リソースの詳細」。Resources で選んだものを出す（ADR 0044） */
export function ResourceDetailDrawer() {
  const target = useWorkspace((s) => s.resourceDetail);
  if (!target) return <p className={ui.empty}>Resources で選ぶと、ここに詳細が出ます</p>;
  return (
    <CloseDetail.Provider value={() => useWorkspace.setState({ resourceDetail: null })}>
      <DefinitionProperties selection={target} />
    </CloseDetail.Provider>
  );
}

/** アウトプット・KokoState 定義・System・マテリアルの Properties */
export function DefinitionProperties({
  selection,
}: {
  selection: { kind: "output"; id: string } | DetailTarget;
}) {
  useWorkspace((s) => s.rev);
  switch (selection.kind) {
    case "output":
      return <OutputProperties id={selection.id} />;
    case "koko":
      return <KokoDefProperties key={selection.id} id={selection.id} />;
    case "system":
      return <SystemProperties id={selection.id} />;
    case "typedef":
      return <TypeDefProperties id={selection.id} />;
    case "material":
      return <MaterialProperties id={selection.id} />;
    case "asset":
      return <AssetProperties key={selection.id} id={selection.id} />;
    case "folder":
      return <FolderProperties id={selection.id} />;
    case "prefab":
      return <PrefabProperties id={selection.id} />;
  }
}

function useSafe() {
  const [error, setError] = useState<string | null>(null);
  const safely = (fn: () => void) => {
    try {
      setError(null);
      fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return { error, safely };
}

function NameRow(props: {
  id: string;
  value: string;
  disabled?: boolean;
  mark?: ChangeKind | null;
  target?: ChangeTarget;
  onCommit: (v: string) => void;
}) {
  return (
    <MarkedLine kind={props.mark ?? null} target={props.target}>
      <div className={ui.field}>
        <label className={ui.label} htmlFor={`n-${props.id}`}>
          Name
        </label>
        <input
          id={`n-${props.id}`}
          key={`${props.id}:${props.value}`}
          className={ui.input}
          defaultValue={props.value}
          disabled={props.disabled}
          onBlur={(e) => e.target.value !== props.value && props.onCommit(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
    </MarkedLine>
  );
}

// ---------------------------------------------------------------------------

function OutputProperties({ id }: { id: string }) {
  useWorkspace((st) => st.rev);
  const packages = useWorkspace((st) => st.packages);
  const project = useProject();
  const canEdit = useCanEdit();
  const saved = useSavedFiles();
  const expanded = useExpanded();
  const output = project.output(id);
  if (!output) return <p className={ui.empty}>アウトプットが見つかりません</p>;
  const editing = canEdit;
  // 動かす System：アウトプットのものと、置いたプレハブのもの（ADR 0076）
  const running = expanded.outputs.find((o) => o.id === id)?.systems ?? output.systems;
  const fromPrefabs = running.filter((s) => !output.systems.some((o) => o.id === s.id));
  // このプロジェクトの System と、依存のライブラリの System（`@別名/名前`。ADR 0015）
  const systems = [
    ...project.systems().map((s) => ({
      id: s.id,
      name: s.name,
      code: () => project.code(s.id)?.toString() ?? "",
    })),
    ...packageSystems(packages.values()).map((s) => ({
      id: s.id,
      name: `@${s.alias}/${s.name}`,
      code: () => s.code,
    })),
  ];
  const update = (patch: Partial<OutputDef>) => project.updateOutput({ ...output, ...patch });
  const systemName = (sid: string) => systems.find((s) => s.id === sid)?.name;
  // 有効な System のコードから読み取った、要る権限（ADR 0012）
  const capabilities = [
    ...new Set(
      running
        .filter((s) => s.enabled)
        .flatMap(
          (s) =>
            inferCapabilities(s.id, systems.find((d) => d.id === s.id)?.code() ?? "").capabilities,
        ),
    ),
  ].sort();
  const changed = outputChange(saved, output);
  // ライブラリは Entity を持たない。Entity があるうちはライブラリにできない（ADR 0055）
  const hasEntities = project.entities(id).length > 0;
  const changeKind = (kind: OutputDef["kind"]) => {
    const { resources: _old, ...rest } = output;
    project.updateOutput(kind === "library" ? { ...rest, kind, resources: [] } : { ...rest, kind });
  };

  return (
    <>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <ChangeMark kind={changed.kind} target={{ entry: `output:${id}` }} />
          <h3 className={ui.sectionTitle}>Output</h3>
        </div>
        <p className={ui.muted}>
          ルートはアウトプットそのものです。Entity ではないので KokoState や Transform
          は付きません。
        </p>
        <NameRow
          id={id}
          value={output.name}
          mark={changed.name}
          target={{ entry: `output:${id}`, part: "name" }}
          disabled={!editing}
          onCommit={(name) => update({ name })}
        />
        <MarkedLine kind={changed.outputKind} target={{ entry: `output:${id}`, part: "kind" }}>
          <div className={ui.field}>
            <label className={ui.label} htmlFor={`kind-${id}`}>
              Kind
            </label>
            <select
              id={`kind-${id}`}
              className={ui.select}
              value={output.kind}
              disabled={!editing}
              onChange={(e) => changeKind(e.target.value as OutputDef["kind"])}
            >
              <option value="item">アイテム</option>
              <option value="world">ワールド</option>
              <option value="library" disabled={hasEntities && output.kind !== "library"}>
                {hasEntities && output.kind !== "library"
                  ? "ライブラリ（Entity があると選べません）"
                  : "ライブラリ"}
              </option>
            </select>
          </div>
        </MarkedLine>
        <div className={ui.field}>
          <span className={ui.label}>使う権限</span>
          <span
            className={ui.toolbar}
            title="有効な System のコードから読み取った、要る Capability。セッションでは、これと置いた物への付与・World の上限で判定する"
          >
            {capabilities.length === 0 ? (
              <span className={ui.muted}>なし</span>
            ) : (
              capabilities.map((c) => (
                <span key={c} className={ui.badge}>
                  {c}
                </span>
              ))
            )}
          </span>
        </div>
        <MarkedLine kind={changed.exposure} target={{ entry: `output:${id}`, part: "exposure" }}>
          <div className={ui.field}>
            <label className={ui.label} htmlFor={`exposure-${id}`}>
              外からの見え方
            </label>
            <select
              id={`exposure-${id}`}
              className={ui.select}
              value={output.exposure ?? "interactive"}
              disabled={!editing}
              title="セッションで、別の作者の Item / World からどう見えるか。インタラクション可能：公開した Contract を受ける／衝突のみ：Raycast は当たるが Contract は受けない／非公開：Raycast も当たらない"
              onChange={(e) => update({ exposure: e.target.value as OutputExposure })}
            >
              <option value="interactive">インタラクション可能</option>
              <option value="collision">衝突のみ</option>
              <option value="private">非公開</option>
            </select>
          </div>
        </MarkedLine>
        {output.kind === "world" && (
          <MarkedLine kind={changed.guestPolicy} target={{ entry: `output:${id}`, part: "guest" }}>
            <div className={ui.field}>
              <label className={ui.label} htmlFor={`guest-${id}`}>
                外から来た Item
              </label>
              <select
                id={`guest-${id}`}
                className={ui.select}
                value={output.guestPolicy ?? "interactive"}
                disabled={!editing}
                title="セッションでこの World が土台（最初に置いた World）のとき、別の作者の Item に許すこと。インタラクション可能：公開された Contract も送れる／衝突のみ：Raycast と一時的な effect まで／許さない：自分の配置の外は見つからない"
                onChange={(e) => update({ guestPolicy: e.target.value as GuestPolicy })}
              >
                <option value="interactive">インタラクション可能</option>
                <option value="collision">衝突のみ</option>
                <option value="deny">許さない</option>
              </select>
            </div>
          </MarkedLine>
        )}
      </div>
      <ThumbnailField
        output={output}
        editing={editing}
        onChange={(thumbnail) => {
          const { thumbnail: _old, ...rest } = output;
          project.updateOutput(thumbnail ? { ...rest, thumbnail } : rest);
        }}
      />
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <ChangeMark kind={changed.systems} target={{ entry: `output:${id}`, part: "systems" }} />
          <h3 className={ui.sectionTitle}>Systems</h3>
          <span className={ui.badge}>{running.filter((s) => s.enabled).length} 有効</span>
        </div>
        <p className={ui.muted}>
          このアウトプットで動かす System と実行順。無効な System は Query
          にマッチしても動きません。
        </p>
        <SystemRows
          systems={output.systems}
          nameOf={systemName}
          editing={editing}
          rowMark={(sid) => changed.systemRows[sid] ?? null}
          markTarget={{ entry: `output:${id}`, part: "systems" }}
          onChange={(list) => update({ systems: list })}
        />
        {running.length === 0 && <p className={ui.empty}>System がありません</p>}
        {fromPrefabs.length > 0 && (
          <>
            <p className={ui.muted}>
              置いたプレハブの System。上の System
              のあとに動きます。切ると、このアウトプットでは動きません。
            </p>
            <ul className={ui.list} aria-label="プレハブの System">
              {fromPrefabs.map((ref) => {
                const def = systems.find((s) => s.id === ref.id);
                return (
                  <li key={ref.id} className={ui.item}>
                    <input
                      type="checkbox"
                      aria-label={`${def?.name ?? ref.id} を有効にする`}
                      checked={ref.enabled}
                      disabled={!editing}
                      onChange={(e) =>
                        update({
                          systems: [...output.systems, { id: ref.id, enabled: e.target.checked }],
                        })
                      }
                    />
                    <span className={ui.itemName}>{def?.name ?? "（削除された System）"}</span>
                    <span className={ui.badge}>プレハブ</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {editing && (
          <SystemAdder
            systems={output.systems}
            choices={systems}
            onChange={(list) => update({ systems: list })}
          />
        )}
      </div>
    </>
  );
}

/**
 * 動かす System の並びと「入・切」。アウトプットと、プレハブで同じ画面を使う（ADR 0076）。
 * 並び順が実行順。
 */
export function SystemRows(props: {
  systems: OutputSystem[];
  nameOf: (id: string) => string | undefined;
  editing: boolean;
  /** 最後の保存からの変化の印（行ごと）。なければ出さない */
  rowMark?: (id: string) => ChangeKind | null;
  markTarget?: ChangeTarget;
  markTargetFor?: (id: string) => ChangeTarget | undefined;
  rowDecoration?: (id: string) => ReactNode;
  onChange: (systems: OutputSystem[]) => void;
}) {
  const { systems, editing, onChange } = props;
  const move = (i: number, d: -1 | 1) => {
    const list = [...systems];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j] as OutputSystem, list[i] as OutputSystem];
    onChange(list);
  };
  return (
    <ul className={ui.list}>
      {systems.map((ref, i) => {
        const name = props.nameOf(ref.id);
        return (
          <li key={ref.id} className={ui.item}>
            {props.rowMark && (
              <ChangeMark
                kind={props.rowMark(ref.id)}
                target={props.markTargetFor?.(ref.id) ?? props.markTarget}
              />
            )}
            {props.rowDecoration?.(ref.id)}
            <input
              type="checkbox"
              aria-label={`${name ?? ref.id} を有効にする`}
              checked={ref.enabled}
              disabled={!editing}
              onChange={(e) =>
                onChange(
                  systems.map((s) => (s.id === ref.id ? { ...s, enabled: e.target.checked } : s)),
                )
              }
            />
            <span className={ui.itemName}>{name ?? "（削除された System）"}</span>
            <button
              type="button"
              className={ui.iconBtn}
              aria-label="上へ"
              disabled={!editing || i === 0}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className={ui.iconBtn}
              aria-label="下へ"
              disabled={!editing || i === systems.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className={ui.iconBtn}
              aria-label="一覧から外す"
              disabled={!editing}
              onClick={() => onChange(systems.filter((s) => s.id !== ref.id))}
            >
              ✕
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** まだ並びにない System を、並びの終わりに足す */
export function SystemAdder(props: {
  systems: OutputSystem[];
  choices: { id: string; name: string }[];
  onChange: (systems: OutputSystem[]) => void;
}) {
  const unused = props.choices.filter((s) => !props.systems.some((o) => o.id === s.id));
  if (unused.length === 0) return null;
  return (
    <select
      className={ui.select}
      aria-label="System を追加"
      value=""
      onChange={(e) =>
        e.target.value && props.onChange([...props.systems, { id: e.target.value, enabled: true }])
      }
    >
      <option value="">＋ System を追加…</option>
      {unused.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------

function KokoDefProperties({ id }: { id: string }) {
  const { select, openDetail } = useWorkspace();
  const closeDetail = useCloseDetail();
  const queryOf = useSystemQuery();
  const project = useProject();
  const canEdit = useCanEdit();
  const saved = useSavedFiles();
  const { error, safely } = useSafe();
  const def = project.registry().get(id);
  if (!def) return <p className={ui.empty}>KokoState が見つかりません</p>;
  const editing = canEdit && !def.builtin && !isPackageResourceId(id);
  const save = (next: KokoStateDef) => safely(() => project.updateKokoState(next));
  const setField = (fid: string, patch: Partial<FieldDef>) =>
    save({
      ...def,
      fields: def.fields.map((f) => (f.id === fid ? ({ ...f, ...patch } as FieldDef) : f)),
    });

  // アウトプットの Entity と、プレハブの中の Entity（選ぶと、そのプレハブが開く）
  const holders = [...project.entities(), ...project.prefabEntities()].filter(
    (e) => id in e.states,
  );
  const changed = kokoChange(saved, def);
  const queried = project.systems().filter((s) => {
    const q = queryOf(s.id);
    return [...q.with, ...q.without].some((k) => k.id === def.id);
  });

  return (
    <>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <ChangeMark kind={changed.kind} target={{ entry: `koko:${id}` }} />
          <h3 className={ui.sectionTitle}>KokoState</h3>
          {def.builtin && <span className={ui.badge}>Built-in</span>}
        </div>
        {def.builtin && (
          <p className={ui.muted}>Built-in の KokoState です。定義は変更できません。</p>
        )}
        {isPackageResourceId(id) && (
          <p className={ui.muted}>ライブラリの KokoState です。定義は変更できません。</p>
        )}
        <NameRow
          id={id}
          value={def.name}
          mark={changed.name}
          target={{ entry: `koko:${id}`, part: "name" }}
          disabled={!editing}
          onCommit={(name) => save({ ...def, name })}
        />
        <div className={ui.field}>
          <label className={ui.label} htmlFor={`description-${id}`}>
            説明
          </label>
          <textarea
            id={`description-${id}`}
            key={`${id}:${def.description ?? ""}`}
            className={ui.input}
            rows={3}
            defaultValue={def.description ?? ""}
            disabled={!editing}
            onBlur={(e) => {
              if (e.target.value !== (def.description ?? ""))
                save({ ...def, description: e.target.value });
            }}
          />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor={`role-${id}`}>
            役割
          </label>
          <select
            id={`role-${id}`}
            className={ui.select}
            value={def.role ?? ""}
            disabled={!editing}
            title="KokoState を付けるときの絞り込みに使います。動きには関わりません"
            onChange={(e) => {
              const { role: _old, ...rest } = def;
              save(e.target.value ? { ...rest, role: e.target.value } : rest);
            }}
          >
            <option value="">（なし）</option>
            {KOKO_ROLES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        {error && <p className={ui.error}>{error}</p>}
      </div>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <h3 className={ui.sectionTitle}>Fields</h3>
        </div>
        {def.fields.length === 0 && (
          <p className={ui.muted}>
            フィールドがありません。フィールドなしの KokoState は、Query
            で絞り込むためのタグとして使えます。
          </p>
        )}
        {def.fields.map((f) => (
          <KokoFieldRow
            key={f.id}
            koko={def}
            field={f}
            mark={changed.fields[f.id] ?? null}
            editing={editing}
            onPatch={(patch) => setField(f.id, patch)}
            onDelete={() => save({ ...def, fields: def.fields.filter((x) => x.id !== f.id) })}
          />
        ))}
        {editing && (
          <div className={ui.toolbar}>
            <button
              type="button"
              className={ui.btn}
              onClick={() => {
                let n = def.fields.length + 1;
                while (def.fields.some((f) => f.name === `field${n}`)) n++;
                save({
                  ...def,
                  fields: [
                    ...def.fields,
                    { id: newId("f"), name: `field${n}`, type: "number", default: 0 },
                  ],
                });
              }}
            >
              ＋ Add field
            </button>
          </div>
        )}
      </div>
      <UsedTypeDefs def={def} editing={editing} onChange={save} />
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>持っている Entity</h3>
        {holders.length === 0 ? (
          <p className={ui.muted}>
            まだありません。Entity の Inspector の「KokoState を追加」から付けられます。
          </p>
        ) : (
          <ul className={ui.list}>
            {holders.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className={ui.item}
                  onClick={() => select({ kind: "entity", id: e.id })}
                >
                  <span className={ui.itemName}>
                    {"prefab" in e
                      ? `プレハブ「${project.prefab(e.prefab)?.name ?? e.prefab}」の中の「${e.name}」`
                      : e.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <h3 className={ui.sectionTitle}>クエリしている System</h3>
        {queried.length === 0 ? (
          <p className={ui.muted}>まだどの System もクエリしていません</p>
        ) : (
          <ul className={ui.list}>
            {queried.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={ui.item}
                  onClick={() => openDetail({ kind: "system", id: s.id })}
                >
                  <span className={ui.itemName}>{s.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing && (
        <div className={ui.section}>
          <div className={ui.toolbar}>
            <button
              type="button"
              className={ui.btnDanger}
              onClick={() => {
                const message =
                  holders.length === 0
                    ? `${def.name} を削除しますか？`
                    : `${def.name} を削除すると、${holders.length} 個の Entity から外れます。削除しますか？`;
                if (window.confirm(message)) {
                  project.removeKokoState(id);
                  closeDetail();
                }
              }}
            >
              KokoState を削除
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * KokoState が使う型の定義（ADR 0065）。チェックを入れた型の定義が公開している型の名前を、
 * フィールドの型から使える。ID で結び付くので、型の定義の名前を変えても切れない。
 */
function UsedTypeDefs(props: {
  def: KokoStateDef;
  editing: boolean;
  onChange: (next: KokoStateDef) => void;
}) {
  const { def, editing } = props;
  const project = useProject();
  const packages = useWorkspace((s) => s.packages);
  const { openDetail } = useWorkspace();
  const own = project.typeDefs().map((t) => ({ id: t.id, label: t.name, own: true }));
  const fromLibraries = packageTypeDefs(packages.values()).map((t) => ({
    id: t.id,
    label: `@${t.alias}${t.path}`,
    own: false,
  }));
  const all = [...own, ...fromLibraries];
  const used = new Set(def.typeDefs ?? []);
  // 一覧にない ID（消した型の定義・外した依存）も、外せるように出す
  const missing = [...used].filter((id) => !all.some((t) => t.id === id));
  if (all.length === 0 && missing.length === 0) return null;
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...used, id] : [...used].filter((x) => x !== id);
    const { typeDefs: _old, ...rest } = def;
    props.onChange(next.length > 0 ? { ...rest, typeDefs: next } : rest);
  };
  return (
    <div className={ui.section}>
      <h3 className={ui.sectionTitle}>使う型の定義</h3>
      <p className={ui.muted}>チェックを入れた型の定義の型を、フィールドの型で使えます。</p>
      <ul className={ui.list}>
        {all.map((t) => (
          <li key={t.id} className={ui.row}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
              <input
                type="checkbox"
                checked={used.has(t.id)}
                disabled={!editing}
                onChange={(e) => toggle(t.id, e.target.checked)}
              />
              <span>{t.label}</span>
            </label>
            {t.own && (
              <button
                type="button"
                className={ui.btn}
                onClick={() => openDetail({ kind: "typedef", id: t.id })}
              >
                開く
              </button>
            )}
          </li>
        ))}
        {missing.map((id) => (
          <li key={id} className={ui.row}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
              <input
                type="checkbox"
                checked
                disabled={!editing}
                onChange={() => toggle(id, false)}
              />
              <span className={ui.badgeError}>見つからない型の定義</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** 型の定義（ADR 0065）：名前・コード・使っている KokoState */
function TypeDefProperties({ id }: { id: string }) {
  const { openSystem, openDetail, showProblem } = useWorkspace();
  const closeDetail = useCloseDetail();
  const { error, safely } = useSafe();
  const problems = useProblems().filter((p) => p.subject.id === id);
  const project = useProject();
  const canEdit = useCanEdit();
  const saved = useSavedFiles();
  const def = project.typeDef(id);
  if (!def) return <p className={ui.empty}>型の定義が見つかりません</p>;
  const users = project.kokostates().filter((k) => k.typeDefs?.includes(id));
  const changed = typeDefChange(saved, id, def.name, project.code(id)?.toString() ?? "");

  return (
    <>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <ChangeMark kind={changed.kind} target={{ entry: `code:${id}` }} />
          <h3 className={ui.sectionTitle}>型の定義</h3>
          <span className={ui.badgeBrand}>Types</span>
        </div>
        <NameRow
          id={id}
          value={def.name}
          mark={changed.name}
          target={{ entry: `code:${id}`, part: "name" }}
          disabled={!canEdit}
          onCommit={(name) => safely(() => project.renameTypeDef(id, name))}
        />
        {error && <p className={ui.error}>{error}</p>}
        {problems.map((p) => (
          <button
            key={`${p.freshness}:${p.id}`}
            type="button"
            className={ui.problem}
            data-fresh={p.freshness}
            onClick={() => showProblem(p)}
          >
            <span className={ui.problemPlace}>
              {problemPlace(def.name, p)}
              <span className={ui.problemKind}>{problemKind(p)}</span>
            </span>
            <span>{p.message}</span>
          </button>
        ))}
        <MarkedLine kind={changed.code} target={{ entry: `code:${id}`, part: "code" }}>
          <div className={ui.toolbar}>
            <button type="button" className={ui.btnPrimary} onClick={() => openSystem(id)}>
              コードを開く
            </button>
          </div>
        </MarkedLine>
        <p className={ui.muted}>
          type と interface を書きます。export を付けた型を、KokoState
          の「使う型の定義」に入れると、フィールドの型で使えます。
        </p>
      </div>
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>使っている KokoState</h3>
        {users.length === 0 ? (
          <p className={ui.muted}>
            まだありません。KokoState の「使う型の定義」でチェックを入れると使えます。
          </p>
        ) : (
          <ul className={ui.list}>
            {users.map((k) => (
              <li key={k.id}>
                <button
                  type="button"
                  className={ui.item}
                  onClick={() => openDetail({ kind: "koko", id: k.id })}
                >
                  <span className={ui.itemName}>{k.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {canEdit && (
        <div className={ui.section}>
          <div className={ui.toolbar}>
            <button
              type="button"
              className={ui.btnDanger}
              onClick={() => {
                const message =
                  users.length === 0
                    ? `${def.name} を削除しますか？`
                    : `${def.name} を削除すると、${users.length} 個の KokoState で、この型を使うフィールドが型エラーになります。削除しますか？`;
                if (window.confirm(message)) {
                  project.removeTypeDef(id);
                  closeDetail();
                }
              }}
            >
              型の定義を削除
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function SystemProperties({ id }: { id: string }) {
  const { openSystem, select, showProblem } = useWorkspace();
  const closeDetail = useCloseDetail();
  const queryOf = useSystemQuery();
  const { error, safely } = useSafe();
  const problems = useProblems().filter((p) => p.subject.id === id);
  const project = useProject();
  const canEdit = useCanEdit();
  const saved = useSavedFiles();
  const def = project.system(id);
  if (!def) return <p className={ui.empty}>System が見つかりません</p>;
  const editing = canEdit;
  const q = queryOf(id);
  const usedBy = project.outputs().filter((o) => o.systems.some((s) => s.id === id));
  const changed = systemChange(saved, id, def.name, project.code(id)?.toString() ?? "");

  return (
    <>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <ChangeMark kind={changed.kind} target={{ entry: `code:${id}` }} />
          <h3 className={ui.sectionTitle}>System</h3>
          <span className={ui.badgeBrand}>Script</span>
        </div>
        <NameRow
          id={id}
          value={def.name}
          mark={changed.name}
          target={{ entry: `code:${id}`, part: "name" }}
          disabled={!editing}
          onCommit={(name) => safely(() => project.renameSystem(id, name))}
        />
        {error && <p className={ui.error}>{error}</p>}
        {problems.map((p) => (
          <button
            key={`${p.freshness}:${p.id}`}
            type="button"
            className={ui.problem}
            data-fresh={p.freshness}
            onClick={() => showProblem(p)}
          >
            <span className={ui.problemPlace}>
              {problemPlace(def.name, p)}
              <span className={ui.problemKind}>{problemKind(p)}</span>
            </span>
            <span>{p.message}</span>
          </button>
        ))}
        <MarkedLine kind={changed.code} target={{ entry: `code:${id}`, part: "code" }}>
          <div className={ui.toolbar}>
            <button type="button" className={ui.btnPrimary} onClick={() => openSystem(id)}>
              コードを開く
            </button>
          </div>
        </MarkedLine>
      </div>
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>Query</h3>
        <p className={ui.muted}>
          この System が処理する Entity の条件（コードの query から読み取り）
        </p>
        <div className={ui.field}>
          <span className={ui.label}>With</span>
          <span className={ui.toolbar}>
            {q.with.length === 0 ? (
              <span className={ui.muted}>なし</span>
            ) : (
              q.with.map((k) => (
                <span
                  key={k.id ?? k.name}
                  className={k.id ? ui.badgeBrand : ui.badgeError}
                  title={k.id ? undefined : "見つからない KokoState"}
                >
                  {k.name}
                </span>
              ))
            )}
          </span>
        </div>
        <div className={ui.field}>
          <span className={ui.label}>Without</span>
          <span className={ui.toolbar}>
            {q.without.length === 0 ? (
              <span className={ui.muted}>なし</span>
            ) : (
              q.without.map((k) => (
                <span
                  key={k.id ?? k.name}
                  className={k.id ? ui.badge : ui.badgeError}
                  title={k.id ? undefined : "見つからない KokoState"}
                >
                  {k.name}
                </span>
              ))
            )}
          </span>
        </div>
      </div>
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>使っているアウトプット</h3>
        {usedBy.length === 0 ? (
          <p className={ui.muted}>
            どのアウトプットでも使われていません。アウトプットの Systems に追加すると動きます。
          </p>
        ) : (
          <ul className={ui.list}>
            {usedBy.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className={ui.item}
                  onClick={() => select({ kind: "output", id: o.id })}
                >
                  <span className={ui.itemName}>{o.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing && (
        <div className={ui.section}>
          <div className={ui.toolbar}>
            <button
              type="button"
              className={ui.btnDanger}
              onClick={() => {
                if (confirm(`${def.name} を削除しますか？`)) {
                  project.removeSystem(id);
                  closeDetail();
                }
              }}
            >
              System を削除
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function MaterialProperties({ id }: { id: string }) {
  const closeDetail = useCloseDetail();
  const { error, safely } = useSafe();
  const project = useProject();
  const canEdit = useCanEdit();
  const saved = useSavedFiles();
  const m = project.material(id);
  if (!m) return <p className={ui.empty}>マテリアルが見つかりません</p>;
  const editing = canEdit;
  const users = project.entities().filter((e) => e.states["builtin.Mesh"]?.material === id);
  const changed = materialChange(saved, m);
  const slider = (key: "roughness" | "metalness", label: string) => (
    <div className={ui.field}>
      <label className={ui.label} htmlFor={`${key}-${id}`}>
        {label}
      </label>
      <span className={ui.color}>
        <input
          id={`${key}-${id}`}
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={m[key]}
          disabled={!editing}
          style={{ flex: 1 }}
          onChange={(e) => project.updateMaterial({ ...m, [key]: Number(e.target.value) })}
        />
        <code className={ui.num}>{m[key].toFixed(2)}</code>
      </span>
    </div>
  );
  return (
    <>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <ChangeMark kind={changed.kind} target={{ entry: `material:${id}` }} />
          <h3 className={ui.sectionTitle}>Material</h3>
        </div>
        <MaterialPreview
          color={m.color}
          roughness={m.roughness}
          metalness={m.metalness}
          map={m.map ?? null}
        />
        <NameRow
          id={id}
          value={m.name}
          mark={changed.name}
          target={{ entry: `material:${id}`, part: "name" }}
          disabled={!editing}
          onCommit={(name) => safely(() => project.updateMaterial({ ...m, name }))}
        />
        {error && <p className={ui.error}>{error}</p>}
        <div className={ui.field}>
          <span className={ui.label}>Shader</span>
          <span className={ui.toolbar}>
            <span className={ui.badge}>標準（固定）</span>
            <button
              type="button"
              className={ui.btn}
              disabled
              title="独自シェーダーは初版の対象外です"
            >
              開く
            </button>
          </span>
        </div>
        <MarkedLine kind={changed.color} target={{ entry: `material:${id}`, part: "color" }}>
          <FieldInput
            koko="material"
            field={{ id: "color", name: "Color", type: "Color", default: "#ffffff" }}
            value={m.color}
            choices={{ materials: [], entities: [] }}
            disabled={!editing}
            onChange={(v) => project.updateMaterial({ ...m, color: String(v) })}
          />
        </MarkedLine>
        <MarkedLine
          kind={changed.roughness}
          target={{ entry: `material:${id}`, part: "roughness" }}
        >
          {slider("roughness", "粗さ")}
        </MarkedLine>
        <MarkedLine
          kind={changed.metalness}
          target={{ entry: `material:${id}`, part: "metalness" }}
        >
          {slider("metalness", "金属感")}
        </MarkedLine>
        <MarkedLine kind={changed.map} target={{ entry: `material:${id}`, part: "map" }}>
          <div className={ui.field}>
            <label className={ui.label} htmlFor={`map-${id}`}>
              画像
            </label>
            <select
              id={`map-${id}`}
              className={ui.select}
              value={m.map ?? ""}
              disabled={!editing}
              onChange={(e) => project.updateMaterial({ ...m, map: e.target.value || null })}
            >
              <option value="">（なし）</option>
              {project
                .assets()
                .filter((a) => a.kind === "image")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </div>
        </MarkedLine>
        <p className={ui.muted}>
          ここで変えると、このマテリアルを使っているすべてのモノに反映されます（{users.length}{" "}
          個）。
        </p>
      </div>
      {editing && (
        <div className={ui.section}>
          <div className={ui.toolbar}>
            <button
              type="button"
              className={ui.btnDanger}
              onClick={() => {
                project.removeMaterial(id);
                closeDetail();
              }}
            >
              マテリアルを削除
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function AssetProperties({ id }: { id: string }) {
  const project = useProject();
  const canEdit = useCanEdit();
  const { error, safely } = useSafe();
  const file = useAssetFile(id);
  // undefined は読んでいる間、null は読めなかった
  const [image, setImage] = useState<ImageInfo | null | undefined>(undefined);
  const [model, setModel] = useState<ModelInfo | null | undefined>(undefined);
  const graph = useDependencyGraph();
  const { select, openDetail, outputId, setOutput } = useWorkspace();
  const asset = project.asset(id);
  /** 使っている Entity を選ぶ（別のアウトプットの Entity なら、そのアウトプットに切り替える） */
  const pickEntity = (entityId: string) => {
    const out = project.entity(entityId)?.output;
    if (out && out !== outputId) setOutput(out);
    select({ kind: "entity", id: entityId });
  };
  if (!asset) return <p className={ui.empty}>素材が見つかりません</p>;
  const title = asset.kind === "model" ? "モデル" : asset.kind === "image" ? "テクスチャ" : "音声";
  const num = (n: number) => n.toLocaleString("ja-JP");
  const len = (n: number) => (Math.round(n * 100) / 100).toString();
  const LOADING = "読み込んでいます…";
  const FAILED = "読めません";
  const loaded = file && file !== "failed" ? file : null;
  const rows: [string, string][] = [
    ["形式", loaded?.type || asset.contentType],
    ["大きさ", loaded ? formatBytes(loaded.bytes) : file === "failed" ? FAILED : LOADING],
  ];
  if (asset.kind === "image") {
    rows.push([
      "解像度",
      image ? `${num(image.width)} × ${num(image.height)} px` : image === null ? FAILED : LOADING,
    ]);
  }
  if (asset.kind === "model") {
    if (model === null) {
      rows.push(["中身", FAILED]);
    } else if (model) {
      rows.push(
        ["ポリゴン（三角形）", num(model.triangles)],
        ["頂点", num(model.vertices)],
        ["メッシュ", num(model.meshes)],
        ["マテリアル", num(model.materials)],
        ["テクスチャ", num(model.textures)],
        ["アニメーション", num(model.animations)],
        ["寸法（幅 × 高さ × 奥行き）", model.size.map(len).join(" × ")],
      );
    } else {
      rows.push(["中身", LOADING]);
    }
  }
  return (
    <div className={ui.section}>
      <div className={ui.sectionHead}>
        <h3 className={ui.sectionTitle}>{title}</h3>
      </div>
      <NameRow
        id={id}
        value={asset.name}
        disabled={!canEdit}
        onCommit={(name) => safely(() => project.renameAsset(id, name))}
      />
      {error && <p className={ui.error}>{error}</p>}
      {asset.kind === "image" && <ImagePreview id={asset.id} name={asset.name} onInfo={setImage} />}
      {asset.kind === "model" && <ModelPreview id={asset.id} onInfo={setModel} />}
      {asset.kind === "audio" && (
        <p className={ui.muted}>音声は、Resources の下の「試聴」で聞けます。</p>
      )}
      <InfoList label={`${title}の情報`} rows={rows} />
      <h3 className={ui.sectionTitle}>使っているもの</h3>
      {(() => {
        // 消したり差し替えたりする前に、どこへ影響するかが分かるように（依存グラフから）
        const users = graph ? usersOf(graph, { kind: "asset", id }) : [];
        if (users.length === 0) return <p className={ui.muted}>まだどこでも使われていません。</p>;
        return (
          <ul className={ui.list}>
            {users.map((u) => (
              <li key={`${u.kind}:${u.id}`}>
                <button
                  type="button"
                  className={ui.item}
                  onClick={() =>
                    u.kind === "material"
                      ? openDetail({ kind: "material", id: u.id })
                      : pickEntity(u.id)
                  }
                >
                  <span className={ui.itemName}>
                    {u.kind === "material"
                      ? `マテリアル「${project.material(u.id)?.name ?? u.id}」`
                      : `Entity「${project.entity(u.id)?.name ?? u.id}」`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        );
      })()}
    </div>
  );
}

/**
 * プレハブの詳細（ADR 0076）：名前・編集する場所・System の並び・置いたインスタンス。
 * ここから、プレハブを開いて中身を直し（Hierarchy と Inspector が、プレハブの中身に切り替わる）、
 * いまのアウトプットにインスタンスを置ける。
 */
function PrefabProperties({ id }: { id: string }) {
  const closeDetail = useCloseDetail();
  const project = useProject();
  const canEdit = useCanEdit();
  const readOnly = isPackageResourceId(id);
  const canChange = canEdit && !readOnly;
  const role = useWorkspace((st) => st.role);
  const saved = useSavedFiles();
  const { error, safely } = useSafe();
  const { select, outputId, setOutput, viewPoint, openPrefab, closePrefab } = useWorkspace();
  const packages = useWorkspace((st) => st.packages);
  const editMode = useWorkspace((st) => st.mode === "edit");
  const open = useWorkspace((st) => st.mode === "edit" && st.editingPrefab?.id === id);
  const prefab = project.prefab(id);
  if (!prefab) return <p className={ui.empty}>プレハブが見つかりません</p>;
  const index = ResourcePathIndex.fromSnapshot(project.snapshot());
  const ref = parsePackageResourceId(id);
  const library = ref
    ? [...packages.values()].find(
        (r) =>
          r.status === "ready" &&
          r.dependency.packageId === ref.packageId &&
          r.dependency.version === ref.version,
      )
    : undefined;
  const libraryPath =
    library?.status === "ready" && ref
      ? library.manifest.exports.find((e) => e.id === ref.resourceId)?.path
      : undefined;
  const entities = project.prefabEntities(id);
  const instances = project.instancesOf(id);
  const output = project.output(outputId);
  const canPlace =
    editMode &&
    (role === "editor" || role === "admin") &&
    output !== undefined &&
    output.kind !== "library";
  // このプロジェクトの System と、依存のライブラリの System（アウトプットと同じ。ADR 0015）
  const systems = [
    ...project.systems().map((s) => ({ id: s.id, name: s.name })),
    ...packageSystems(packages.values()).map((s) => ({ id: s.id, name: `@${s.alias}/${s.name}` })),
  ];
  const setSystems = (list: OutputSystem[]) => project.updatePrefab({ ...prefab, systems: list });
  const setEditIn = (place: PrefabEditPlace) => {
    // 初めの設定（その場）は、書かずに持つ
    const { editIn: _old, ...rest } = prefab;
    project.updatePrefab(place === "here" ? rest : { ...rest, editIn: place });
  };
  const place = () =>
    safely(() => {
      const made = project.addInstance({
        output: outputId,
        prefab: id,
        position: viewPoint?.() ?? [0, 1, 0],
      });
      closePrefab();
      select({ kind: "entity", id: made });
    });
  const remove = () => {
    const message =
      instances.length > 0
        ? `プレハブ「${prefab.name}」を消しますか？置いてある ${instances.length} 個のインスタンスは、中身のない Entity として残り、問題として出ます。`
        : `プレハブ「${prefab.name}」を消しますか？`;
    if (!confirm(message)) return;
    project.removePrefab(id);
    closeDetail();
  };
  return (
    <>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          {!readOnly && (
            <ChangeMark
              kind={prefabChange(saved, prefab, entities)}
              target={{ entry: `prefab:${id}` }}
            />
          )}
          <h3 className={ui.sectionTitle}>プレハブ</h3>
        </div>
        <NameRow
          id={id}
          value={prefab.name}
          disabled={!canChange}
          onCommit={(name) => safely(() => project.renamePrefab(id, name))}
        />
        {readOnly && (
          <p className={ui.muted}>
            ライブラリのプレハブは読むだけです。置いたインスタンスは変更できます。
          </p>
        )}
        {error && <p className={ui.error}>{error}</p>}
        <div className={ui.field}>
          <label className={ui.label} htmlFor={`edit-in-${id}`}>
            編集する場所
          </label>
          <select
            id={`edit-in-${id}`}
            className={ui.select}
            value={prefab.editIn ?? "here"}
            disabled={!canChange}
            title="プレハブを開いたときに、中身を出す場所。その場：いまいるワークスペースの空間に出す（小さなプレハブ向け）／離れた空間：セッションから離した空間に、ポータルで入って直す（大きなプレハブ向け）"
            onChange={(e) => setEditIn(e.target.value as PrefabEditPlace)}
          >
            <option value="here">その場</option>
            <option value="isolated">離れた空間</option>
          </select>
        </div>
        <InfoList
          label="プレハブの情報"
          rows={[
            [
              "場所",
              ref
                ? `@${library?.dependency.alias ?? ref.packageId}${libraryPath ?? ""} · v${ref.version}`
                : (index.pathOf(id) ?? "（フォルダが輪になっています）"),
            ],
            ["中の Entity", `${entities.length} 個`],
            ["インスタンス", `${instances.length} 個`],
          ]}
        />
        <div className={ui.toolbar}>
          {open ? (
            <button type="button" className={ui.btn} onClick={closePrefab}>
              アウトプットに戻る
            </button>
          ) : (
            <button
              type="button"
              className={ui.btnPrimary}
              disabled={!editMode}
              title={
                editMode
                  ? readOnly
                    ? "Hierarchy と Inspector で、プレハブの中身を見る"
                    : "Hierarchy と Inspector で、プレハブの中身を直す"
                  : "Play mode 中は開けません"
              }
              onClick={() => openPrefab(id)}
            >
              開く
            </button>
          )}
          <button
            type="button"
            className={ui.btn}
            disabled={!canPlace}
            title={
              output?.kind === "library"
                ? "ライブラリには置けません"
                : "いま開いているアウトプットに、インスタンスを置く"
            }
            onClick={place}
          >
            アウトプットに置く
          </button>
          <button type="button" className={ui.btn} disabled={!canChange} onClick={remove}>
            プレハブを消す
          </button>
        </div>
      </div>
      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <h3 className={ui.sectionTitle}>Systems</h3>
          <span className={ui.badge}>{prefab.systems.filter((s) => s.enabled).length} 有効</span>
        </div>
        <p className={ui.muted}>
          このプレハブの System と実行順。インスタンスを置いたアウトプットで、アウトプットの System
          のあとに動きます。
        </p>
        <SystemRows
          systems={prefab.systems}
          nameOf={(sid) => systems.find((s) => s.id === sid)?.name}
          editing={canChange}
          onChange={setSystems}
        />
        {prefab.systems.length === 0 && <p className={ui.empty}>System がありません</p>}
        {canChange && (
          <SystemAdder systems={prefab.systems} choices={systems} onChange={setSystems} />
        )}
      </div>
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>置いてある所</h3>
        {instances.length === 0 ? (
          <p className={ui.muted}>まだどこにも置いていません。</p>
        ) : (
          <ul className={ui.list} aria-label="インスタンス">
            {instances.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className={ui.item}
                  onClick={() => {
                    // アウトプットのインスタンスは、そのアウトプットで選ぶ。プレハブの中のものは、そのプレハブを開いて選ぶ
                    if ("output" in e && e.output !== outputId) setOutput(e.output);
                    select({ kind: "entity", id: e.id });
                  }}
                >
                  <span className={ui.itemName}>
                    {"output" in e
                      ? `${project.output(e.output)?.name ?? e.output} の「${e.name}」`
                      : `プレハブ「${project.prefab(e.prefab)?.name ?? e.prefab}」の中の「${e.name}」`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** ラベルと値を並べた、読むだけの一覧 */
function InfoList({ label, rows }: { label: string; rows: [string, string][] }) {
  return (
    <dl className={ui.infoList} aria-label={label}>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------

const RESOURCE_KIND_LABEL = {
  kokostate: "KokoState",
  system: "Script",
  material: "Material",
  prefab: "Prefab",
  model: "Model",
  image: "Texture",
  audio: "Audio",
} as const;

/** フォルダの詳細：名前（変えられる）・場所・直下の中身 */
function FolderProperties({ id }: { id: string }) {
  const project = useProject();
  const canEdit = useCanEdit();
  const { error, safely } = useSafe();
  const folder = project.folders().find((f) => f.id === id);
  if (!folder) return <p className={ui.empty}>フォルダが見つかりません</p>;
  const index = ResourcePathIndex.fromSnapshot(project.snapshot());
  const inside = (resource: string) => project.folderOf(resource) === id;
  const children: { id: string; name: string; kind: string }[] = [
    ...project
      .folders()
      .filter((f) => f.parent === id)
      .map((f) => ({ id: f.id, name: f.name, kind: "フォルダ" })),
    ...project
      .kokostates()
      .filter((k) => !k.builtin && inside(k.id))
      .map((k) => ({ id: k.id, name: k.name, kind: RESOURCE_KIND_LABEL.kokostate })),
    ...project
      .systems()
      .filter((x) => inside(x.id))
      .map((x) => ({ id: x.id, name: x.name, kind: RESOURCE_KIND_LABEL.system })),
    ...project
      .materials()
      .filter((m) => inside(m.id))
      .map((m) => ({ id: m.id, name: m.name, kind: RESOURCE_KIND_LABEL.material })),
    ...project
      .prefabs()
      .filter((x) => inside(x.id))
      .map((x) => ({ id: x.id, name: x.name, kind: RESOURCE_KIND_LABEL.prefab })),
    ...project
      .assets()
      .filter((x) => inside(x.id))
      .map((x) => ({ id: x.id, name: x.name, kind: RESOURCE_KIND_LABEL[x.kind] })),
  ];
  return (
    <div className={ui.section}>
      <div className={ui.sectionHead}>
        <h3 className={ui.sectionTitle}>フォルダ</h3>
      </div>
      <NameRow
        id={id}
        value={folder.name}
        disabled={!canEdit}
        onCommit={(name) => safely(() => project.renameFolder(id, name))}
      />
      {error && <p className={ui.error}>{error}</p>}
      <InfoList
        label="フォルダの情報"
        rows={[
          ["場所", index.pathOf(id) ?? "（フォルダが輪になっています）"],
          ["中身", `${children.length} 項目`],
        ]}
      />
      {children.length === 0 ? (
        <p className={ui.muted}>空のフォルダです</p>
      ) : (
        <ul className={ui.list} aria-label="フォルダの中身">
          {children.map((c) => (
            <li key={c.id} className={ui.item}>
              <span className={ui.itemName}>{c.name}</span>
              <span className={ui.badge}>{c.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
