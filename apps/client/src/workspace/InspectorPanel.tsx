import type { EntityId, FieldValue, KokoStateDef, KokoStateValues } from "@tukurium/eks";
import { BUILTIN, type EntityDef, isBuiltin, type MeshShape } from "@tukurium/repo-model";
import { useState } from "react";
import { DefinitionProperties } from "./DefinitionProperties";
import { FieldInput } from "./FieldInput";
import { useCanEdit, useProject } from "./hooks";
import styles from "./InspectorPanel.module.css";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { useSystemQuery } from "./useProblems";

/**
 * Inspector：左に Hierarchy（アウトプットの Entity の木）、右に選んだものの Properties。
 * Play 中は実行中の World を読み取り専用で表示する（要件 §7「編集と実行を分ける」）。
 */
export function InspectorPanel() {
  return (
    <div className={styles.split}>
      <Hierarchy />
      <div className={styles.props}>
        <Properties />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hierarchy

const NEW_ENTITIES: { label: string; shape: MeshShape | null; size: [number, number, number] }[] = [
  { label: "空の Entity", shape: null, size: [1, 1, 1] },
  { label: "ボックス", shape: "box", size: [0.5, 0.5, 0.5] },
  { label: "球", shape: "sphere", size: [0.5, 0.5, 0.5] },
  { label: "円柱", shape: "cylinder", size: [0.5, 0.8, 0.5] },
  { label: "カプセル", shape: "capsule", size: [0.4, 1, 0.4] },
  { label: "平面", shape: "plane", size: [2, 1, 2] },
];

interface TreeNode {
  id: EntityId;
  name: string;
  parent: EntityId | null;
}

function Hierarchy() {
  const { outputId, selection, select, mode, runtime, viewPoint } = useWorkspace();
  const project = useProject();
  const canEdit = useCanEdit();
  useWorkspace((s) => (s.mode === "edit" ? s.rev : s.simRev));
  const [menu, setMenu] = useState(false);
  const output = project.output(outputId);
  const editing = canEdit;
  const rt = mode !== "edit" ? runtime() : null;

  const nodes: TreeNode[] = rt
    ? rt.world.entityIds().map((id) => ({ id, name: rt.nameOf(id), parent: rt.world.parentOf(id) }))
    : project.entities(outputId).map((e) => ({ id: e.id, name: e.name, parent: e.parent }));

  const selectedEntity = selection?.kind === "entity" ? selection.id : null;

  const add = (spec: (typeof NEW_ENTITIES)[number]) => {
    setMenu(false);
    const states: Record<string, KokoStateValues> = {
      [BUILTIN.Transform]: { position: viewPoint?.() ?? [0, 1, 0] },
    };
    if (spec.shape) {
      states[BUILTIN.Mesh] = { shape: spec.shape, size: spec.size };
    }
    const id = project.addEntity({ output: outputId, name: spec.label, states });
    select({ kind: "entity", id });
  };

  const duplicate = () => {
    if (!selectedEntity) return;
    const e = project.entity(selectedEntity);
    if (!e) return;
    const id = project.addEntity({
      output: e.output,
      name: `${e.name} のコピー`,
      parent: e.parent,
      states: e.states,
    });
    select({ kind: "entity", id });
  };

  const remove = () => {
    if (!selectedEntity) return;
    project.removeEntity(selectedEntity);
    select(null);
  };

  const children = (parent: EntityId | null) => nodes.filter((n) => n.parent === parent);
  const renderTree = (parent: EntityId | null, depth: number): React.ReactNode =>
    children(parent).map((n) => (
      <li key={n.id}>
        <button
          type="button"
          className={ui.item}
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-current={selectedEntity === n.id || undefined}
          onClick={() => select({ kind: "entity", id: n.id })}
        >
          <span className={ui.itemName}>{n.name}</span>
        </button>
        {children(n.id).length > 0 && <ul className={ui.list}>{renderTree(n.id, depth + 1)}</ul>}
      </li>
    ));

  return (
    <nav className={styles.tree} aria-label="Hierarchy">
      <div className={styles.treeHead}>
        <h3 className={ui.sectionTitle}>Hierarchy</h3>
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className={ui.iconBtn}
            aria-label="Entity を追加"
            title="Entity を追加"
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={!editing}
            onClick={() => setMenu((v) => !v)}
          >
            ＋
          </button>
          {menu && (
            <ul className={ui.menu} style={{ left: 0, top: 30 }}>
              {NEW_ENTITIES.map((spec) => (
                <li key={spec.label}>
                  <button type="button" className={ui.menuItem} onClick={() => add(spec)}>
                    {spec.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className={ui.btn}
          style={{ height: 26, padding: "0 8px" }}
          disabled={!editing || !selectedEntity}
          onClick={duplicate}
        >
          複製
        </button>
        <button
          type="button"
          className={ui.btn}
          style={{ height: 26, padding: "0 8px" }}
          disabled={!editing || !selectedEntity}
          onClick={remove}
        >
          削除
        </button>
      </div>
      <ul className={ui.list}>
        <li>
          <button
            type="button"
            className={ui.item}
            aria-current={(selection?.kind === "output" && selection.id === outputId) || undefined}
            onClick={() => select({ kind: "output", id: outputId })}
          >
            <span className={ui.itemName}>
              <b>{output?.name ?? "（アウトプットなし）"}</b>
            </span>
            <span className={ui.badge}>{output?.kind === "world" ? "world" : "item"}</span>
          </button>
        </li>
        {renderTree(null, 1)}
      </ul>
      {nodes.length === 0 && <p className={ui.empty}>＋ から Entity を追加できます</p>}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Properties

function Properties() {
  const selection = useWorkspace((s) => s.selection);
  if (!selection) {
    return (
      <div className={ui.section}>
        <p className={ui.muted}>
          Hierarchy
          で選ぶと、ここに設定が出ます。空間ではクロスヘアを物に合わせてクリックしても選べます。KokoState・マテリアル・スクリプトは、Resources
          で選ぶと詳細パネルに出ます。
        </p>
      </div>
    );
  }
  if (selection.kind === "entity") return <EntityProperties id={selection.id} />;
  return <DefinitionProperties selection={selection} />;
}

function EntityProperties({ id }: { id: EntityId }) {
  const { mode, runtime, stop, outputId } = useWorkspace();
  const queryOf = useSystemQuery();
  const project = useProject();
  const canEdit = useCanEdit();
  useWorkspace((s) => (s.mode === "edit" ? s.rev : s.simRev));
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = canEdit;
  const registry = project.registry();

  // Edit：制作データ、Play：実行中の World
  let entity: Pick<EntityDef, "id" | "name" | "parent" | "states"> | undefined;
  const rt = mode !== "edit" ? runtime() : null;
  if (rt) {
    if (rt.world.has(id)) {
      const states: Record<string, KokoStateValues> = {};
      for (const k of rt.world.statesOf(id)) states[k] = structuredClone(rt.world.get(id, k) ?? {});
      entity = { id, name: rt.nameOf(id), parent: rt.world.parentOf(id), states };
    }
  } else {
    entity = project.entity(id);
  }
  if (!entity) {
    return (
      <div className={ui.section}>
        <p className={ui.muted}>
          選んだ Entity は見つかりません（削除されたか、実行中に消えました）。
        </p>
      </div>
    );
  }

  const choices = {
    materials: project.materials().map((m) => ({ id: m.id, name: m.name })),
    entities: project.entities(outputId).map((e) => ({ id: e.id, name: e.name })),
    assets: project.assets(),
  };
  const attached = Object.keys(entity.states);
  const order = (k: string) => (k === BUILTIN.Transform ? 0 : isBuiltin(k) ? 1 : 2);
  attached.sort((a, b) => order(a) - order(b));

  const safely = (fn: () => void) => {
    try {
      setError(null);
      fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const matchedSystems = project.systems().filter((s) => {
    const q = queryOf(s.id);
    const has = (k: { id: string | null }) => k.id !== null && attached.includes(k.id);
    return q.with.length > 0 && q.with.every(has) && !q.without.some(has);
  });

  return (
    <>
      {mode !== "edit" && (
        <div className={ui.section}>
          <p className={ui.notice}>
            Play mode 中は編集できません。Play mode 中の出来事はプロジェクトに残りません。
          </p>
          <div className={ui.toolbar}>
            <button type="button" className={ui.btn} onClick={stop}>
              Edit mode に戻る
            </button>
          </div>
        </div>
      )}
      <div className={ui.section}>
        <div className={ui.row}>
          <label className={ui.label} htmlFor={`name-${id}`}>
            Name
          </label>
          <input
            id={`name-${id}`}
            key={`${id}:${entity.name}`}
            className={ui.input}
            defaultValue={entity.name}
            disabled={!editing}
            onBlur={(e) =>
              e.target.value !== entity.name && project.renameEntity(id, e.target.value)
            }
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </div>
        {editing && (
          <div className={ui.row}>
            <label className={ui.label} htmlFor={`parent-${id}`}>
              親
            </label>
            <select
              id={`parent-${id}`}
              className={ui.select}
              value={entity.parent ?? ""}
              onChange={(e) => safely(() => project.setParent(id, e.target.value || null))}
            >
              <option value="">（なし）</option>
              {choices.entities
                .filter((e) => e.id !== id)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </div>
        )}
        {error && <p className={ui.error}>{error}</p>}
      </div>

      {attached.map((koko) => {
        const def = registry.get(koko);
        if (!def) return null;
        const values = entity.states[koko] ?? {};
        return (
          <section key={koko} className={ui.section} aria-label={def.name}>
            <div className={ui.sectionHead}>
              <h4 className={ui.kokoTitle}>{def.name}</h4>
              {def.builtin ? (
                <span className={ui.badge}>Built-in</span>
              ) : (
                <span className={ui.badgeBrand}>KokoState</span>
              )}
              {editing && (
                <button
                  type="button"
                  className={ui.iconBtn}
                  aria-label={`${def.name} を外す`}
                  title="外す"
                  onClick={() => project.removeState(id, koko)}
                >
                  ✕
                </button>
              )}
            </div>
            {def.fields.length === 0 && (
              <p className={ui.muted}>フィールドなし（タグとして使う KokoState）</p>
            )}
            {def.fields.map((f) => (
              <div key={f.id} className={styles.fieldRow}>
                <FieldInput
                  koko={koko}
                  field={f}
                  value={(values[f.id] ?? f.default) as FieldValue}
                  choices={choices}
                  disabled={!editing}
                  onChange={(v) => safely(() => project.setField(id, koko, f.id, v))}
                />
                {mode === "edit" && (
                  <KeepToggle
                    entity={id}
                    koko={koko}
                    field={f.id}
                    label={`${def.name}.${f.name}`}
                    disabled={!editing}
                  />
                )}
              </div>
            ))}
          </section>
        );
      })}

      {editing && (
        <div className={ui.section}>
          {picker ? (
            <KokoPicker
              defs={registry.all().filter((d) => !attached.includes(d.id))}
              onPick={(d) => {
                safely(() => project.addState(id, d.id));
                setPicker(false);
              }}
              onClose={() => setPicker(false)}
            />
          ) : (
            <button type="button" className={ui.btn} onClick={() => setPicker(true)}>
              ＋ Add KokoState
            </button>
          )}
        </div>
      )}

      <div className={ui.section}>
        <div className={ui.sectionHead}>
          <h3 className={ui.sectionTitle}>Systems</h3>
          <span className={ui.muted}>この Entity をクエリで処理している</span>
        </div>
        {matchedSystems.length === 0 ? (
          <p className={ui.muted}>マッチする System はありません</p>
        ) : (
          <ul className={ui.list}>
            {matchedSystems.map((s) => (
              <li key={s.id} className={ui.item}>
                <span className={ui.itemName}>{s.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function KokoPicker(props: {
  defs: KokoStateDef[];
  onPick: (d: KokoStateDef) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = props.defs.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className={styles.picker}>
      <div className={ui.toolbar}>
        <input
          className={ui.input}
          style={{ flex: 1 }}
          placeholder="KokoState を検索"
          aria-label="KokoState を検索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          // biome-ignore lint/a11y/noAutofocus: 開いた直後に検索できるようにする
          autoFocus
        />
        <button type="button" className={ui.btn} onClick={props.onClose}>
          閉じる
        </button>
      </div>
      <ul className={ui.list}>
        {shown.map((d) => (
          <li key={d.id}>
            <button type="button" className={ui.item} onClick={() => props.onPick(d)}>
              <span className={ui.itemName}>{d.name}</span>
              <span className={d.builtin ? ui.badge : ui.badgeBrand}>
                {d.builtin ? "Built-in" : `${d.fields.length} fields`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className={ui.empty}>付けられる KokoState はありません</p>}
    </div>
  );
}

/**
 * 状態維持のマーク：適用したとき、このフィールドの実行値を引き継ぐ（要件 §7）。
 * マークはアウトプットごとに持つので、同じ KokoState を使う別のアウトプットには波及しない。
 */
function KeepToggle(props: {
  entity: string;
  koko: string;
  field: string;
  label: string;
  disabled: boolean;
}) {
  const project = useProject();
  const outputId = useWorkspace((s) => s.outputId);
  useWorkspace((s) => s.rev);
  const output = project.output(outputId);
  if (!output) return null;
  const match = (k: { entity: string; koko: string; field: string }) =>
    k.entity === props.entity && k.koko === props.koko && k.field === props.field;
  const on = output.keep.some(match);
  return (
    <button
      type="button"
      className={on ? styles.keepOn : styles.keep}
      aria-pressed={on}
      aria-label={`${props.label} を適用時に引き継ぐ`}
      title={on ? "適用時に実行値を引き継ぐ（オン）" : "適用時に実行値を引き継ぐ（オフ）"}
      disabled={props.disabled}
      onClick={() =>
        project.updateOutput({
          ...output,
          keep: on
            ? output.keep.filter((k) => !match(k))
            : [...output.keep, { entity: props.entity, koko: props.koko, field: props.field }],
        })
      }
    >
      維持
    </button>
  );
}
