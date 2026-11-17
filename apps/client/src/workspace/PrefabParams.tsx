import type { FieldValue, KokoStateDef } from "@tukurium/eks";
import {
  expandPrefabForEdit,
  isRootTransformParam,
  newParamName,
  type PrefabDef,
  type PrefabParam,
  paramEntityPath,
  prefabParamList,
  prefabParamResolver,
} from "@tukurium/repo-model";
import { useState } from "react";
import { FieldInput } from "./FieldInput";
import { useProject } from "./hooks";
import styles from "./PrefabParams.module.css";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

/**
 * プレハブのパラメータ（ADR 0082）：プレハブが外から受け取る値。プレハブの中のフィールドを一つずつ指す。
 * - PrefabParamsSection：プレハブの詳細の「プレハブの設定」。足す・名前・必須・説明・消す
 * - ParamToggle：プレハブを開いているときの、Inspector のフィールドごとの切り替え
 * - ParamBadge：置いたインスタンスの、パラメータのフィールドの印
 * - InstanceParamsSection：置いたインスタンスの「プレハブの設定」。パラメータの値をまとめて変える
 */

const newParamId = () => `pp_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

function useDefs(): Map<string, KokoStateDef> {
  const project = useProject();
  useWorkspace((s) => s.rev);
  return new Map(
    project
      .registry()
      .all()
      .map((k) => [k.id, k]),
  );
}

/** パラメータを一つ足す（名前は、初めはフィールドの名前。重なるなら数字を付ける） */
function withParam(
  prefab: PrefabDef,
  target: Pick<PrefabParam, "entity" | "koko" | "field">,
  name: string,
) {
  const order = Math.max(-1, ...Object.values(prefab.params ?? {}).map((p) => p.order)) + 1;
  return {
    ...prefab,
    params: {
      ...prefab.params,
      [newParamId()]: { ...target, name: newParamName(prefab, name), required: false, order },
    },
  };
}

function withoutParam(prefab: PrefabDef, id: string): PrefabDef {
  const { [id]: _gone, ...rest } = prefab.params ?? {};
  const { params: _params, ...base } = prefab;
  return Object.keys(rest).length > 0 ? { ...base, params: rest } : base;
}

/** プレハブの詳細の「プレハブの設定」：パラメータの一覧と、足す所 */
export function PrefabParamsSection({ id, canChange }: { id: string; canChange: boolean }) {
  const project = useProject();
  useWorkspace((s) => s.rev);
  const defs = useDefs();
  const prefab = project.prefab(id);
  const [entity, setEntity] = useState("");
  const [koko, setKoko] = useState("");
  const [field, setField] = useState("");
  if (!prefab) return null;
  const snapshot = project.snapshotWithPackages(useWorkspace.getState().fieldSchemas);
  const resolve = prefabParamResolver(snapshot, defs, id);
  const list = prefabParamList(prefab);
  const entities = expandPrefabForEdit(snapshot, id)?.entities ?? [];
  const chosen = entities.find((e) => e.id === entity);
  const kokos = Object.keys(chosen?.states ?? {}).flatMap((k) => defs.get(k) ?? []);
  const fields = defs.get(koko)?.fields ?? [];
  const names = list.map((p) => p.name);
  const update = (pid: string, patch: Partial<PrefabParam>) => {
    const current = prefab.params?.[pid];
    if (!current) return;
    const next = { ...current, ...patch };
    if (next.description === "") delete next.description;
    project.updatePrefab({ ...prefab, params: { ...prefab.params, [pid]: next } });
  };
  const add = () => {
    const f = fields.find((x) => x.id === field);
    if (!chosen || !f) return;
    project.updatePrefab(
      withParam(prefab, { entity: paramEntityPath(prefab, chosen.id), koko, field }, f.name),
    );
    setField("");
  };
  return (
    <div className={ui.section}>
      <div className={ui.sectionHead}>
        <h3 className={ui.sectionTitle}>プレハブの設定</h3>
        <span className={ui.badge}>パラメータ {list.length}</span>
      </div>
      <p className={ui.muted}>
        外から受け取る値（パラメータ）。スクリプトから作るときに渡せるのは、ここに並べたフィールドだけです。
        置いたインスタンスでは、Inspector の「プレハブの設定」で値を変えます。
      </p>
      {list.length === 0 && <p className={ui.empty}>パラメータがありません</p>}
      <ul className={styles.params} aria-label="パラメータ">
        {list.map((p) => {
          const target = resolve(p);
          const dup = names.filter((n) => n === p.name).length > 1;
          return (
            <li key={p.id} className={styles.param} data-problem={!target || dup || undefined}>
              <div className={styles.paramHead}>
                <input
                  className={ui.input}
                  aria-label="パラメータの名前"
                  defaultValue={p.name}
                  key={p.name}
                  disabled={!canChange}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== p.name) update(p.id, { name });
                    else e.target.value = p.name;
                  }}
                />
                <label className={styles.required}>
                  <input
                    type="checkbox"
                    checked={p.required}
                    disabled={!canChange}
                    onChange={(e) => update(p.id, { required: e.target.checked })}
                  />
                  必須
                </label>
                <button
                  type="button"
                  className={ui.iconBtn}
                  aria-label={`パラメータ ${p.name} を消す`}
                  title="パラメータを消す（フィールドは残ります）"
                  disabled={!canChange}
                  onClick={() => project.updatePrefab(withoutParam(prefab, p.id))}
                >
                  ✕
                </button>
              </div>
              <p className={target ? ui.muted : ui.error}>
                {target
                  ? `${target.entityName} › ${target.koko.name}.${target.field.name}（${target.field.type}）${
                      isRootTransformParam(p) ? "・インスタンスの置き方に結び付きます" : ""
                    }`
                  : "指すフィールドがありません（Entity・KokoState・フィールドのどれかが消えています）"}
              </p>
              {dup && <p className={ui.error}>同じ名前のパラメータがあります</p>}
              <input
                className={ui.input}
                aria-label={`${p.name} の説明`}
                placeholder="説明（コードホバーに出ます）"
                defaultValue={p.description ?? ""}
                key={`d:${p.description ?? ""}`}
                disabled={!canChange}
                onBlur={(e) => {
                  if (e.target.value !== (p.description ?? ""))
                    update(p.id, { description: e.target.value });
                }}
              />
            </li>
          );
        })}
      </ul>
      {canChange && (
        <div className={styles.adder}>
          <select
            className={ui.select}
            aria-label="パラメータにする Entity"
            value={entity}
            onChange={(e) => {
              setEntity(e.target.value);
              setKoko("");
              setField("");
            }}
          >
            <option value="">Entity を選ぶ</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <select
            className={ui.select}
            aria-label="パラメータにする KokoState"
            value={koko}
            disabled={!chosen}
            onChange={(e) => {
              setKoko(e.target.value);
              setField("");
            }}
          >
            <option value="">KokoState を選ぶ</option>
            {kokos.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <select
            className={ui.select}
            aria-label="パラメータにするフィールド"
            value={field}
            disabled={fields.length === 0}
            onChange={(e) => setField(e.target.value)}
          >
            <option value="">フィールドを選ぶ</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <button type="button" className={ui.btn} disabled={!field} onClick={add}>
            パラメータを足す
          </button>
        </div>
      )}
    </div>
  );
}

/** プレハブを開いているときの、フィールドごとの切り替え：このフィールドをパラメータにする・やめる */
export function ParamToggle(props: {
  /** 開いているプレハブ */
  prefab: string;
  /** プレハブを開いたときの Entity の ID */
  entity: string;
  koko: string;
  field: string;
  fieldName: string;
  label: string;
  disabled: boolean;
}) {
  const project = useProject();
  useWorkspace((s) => s.rev);
  const prefab = project.prefab(props.prefab);
  if (!prefab) return null;
  const path = paramEntityPath(prefab, props.entity);
  const found = prefabParamList(prefab).find(
    (p) => p.entity === path && p.koko === props.koko && p.field === props.field,
  );
  return (
    <button
      type="button"
      className={found ? styles.toggleOn : styles.toggle}
      aria-pressed={!!found}
      aria-label={`${props.label} をパラメータにする`}
      title={
        found
          ? `パラメータ「${found.name}」です${found.required ? "（必須）" : ""}。押すと、パラメータをやめます。名前・必須・説明は、プレハブの詳細の「プレハブの設定」で決めます`
          : "外から受け取る値（パラメータ）にする"
      }
      disabled={props.disabled}
      onClick={() =>
        project.updatePrefab(
          found
            ? withoutParam(prefab, found.id)
            : withParam(
                prefab,
                { entity: path, koko: props.koko, field: props.field },
                props.fieldName,
              ),
        )
      }
    >
      {found ? `P：${found.name}` : "P"}
    </button>
  );
}

/** 置いたインスタンスの、パラメータのフィールドの印（プレハブの ID と、ルートからの ID で引く） */
export function ParamBadge(props: { prefab: string; path: string; koko: string; field: string }) {
  const project = useProject();
  useWorkspace((s) => s.rev);
  const prefab = project.prefab(props.prefab);
  const found =
    prefab &&
    prefabParamList(prefab).find(
      (p) => p.entity === props.path && p.koko === props.koko && p.field === props.field,
    );
  if (!found) return null;
  return (
    <span
      className={styles.badge}
      title={`プレハブのパラメータ「${found.name}」です${found.required ? "（必須）" : ""}`}
    >
      P：{found.name}
    </span>
  );
}

/** 置いたインスタンスの「プレハブの設定」：パラメータの値をまとめて変える */
export function InstanceParamsSection(props: {
  /** インスタンスの Entity の ID */
  instance: string;
  prefab: string;
  /** 展開した Entity の値を引く */
  statesOf: (entityId: string) => Record<string, Record<string, unknown>> | undefined;
  /** その値を、インスタンスで決めているか */
  isSet: (p: PrefabParam) => boolean;
  choices: Parameters<typeof FieldInput>[0]["choices"];
  disabled: boolean;
  onChange: (entityId: string, koko: string, field: string, value: FieldValue) => void;
}) {
  const project = useProject();
  useWorkspace((s) => s.rev);
  const defs = useDefs();
  const prefab = project.prefab(props.prefab);
  const list = prefab ? prefabParamList(prefab) : [];
  if (list.length === 0) return null;
  return (
    <section className={styles.instance} aria-label="プレハブの設定">
      <h4 className={ui.sectionTitle}>プレハブの設定</h4>
      <p className={ui.muted}>
        このプレハブのパラメータ。ここで変えた値は、このインスタンスだけに残ります。
      </p>
      {list.map((p) => {
        const entityId = p.entity === "" ? props.instance : `${props.instance}/${p.entity}`;
        const def = defs.get(p.koko);
        const field = def?.fields.find((f) => f.id === p.field);
        const values = props.statesOf(entityId)?.[p.koko];
        if (!def || !field || !values)
          return (
            <p key={p.id} className={ui.error}>
              {p.name}：指すフィールドがありません
            </p>
          );
        const missing = p.required && !isRootTransformParam(p) && !props.isSet(p);
        return (
          <div key={p.id} className={styles.instanceRow} data-problem={missing || undefined}>
            <div className={styles.instanceName} title={p.description}>
              {p.name}
              {p.required && <span className={styles.requiredMark}>必須</span>}
              {missing && <span className={ui.error}>値を入れてください</span>}
            </div>
            <FieldInput
              koko={p.koko}
              field={field}
              value={(field.id in values ? values[field.id] : field.default) as FieldValue}
              choices={props.choices}
              disabled={props.disabled}
              onChange={(v) => props.onChange(entityId, p.koko, field.id, v)}
            />
          </div>
        );
      })}
    </section>
  );
}
