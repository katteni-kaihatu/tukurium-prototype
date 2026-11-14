import {
  acceptsUndefined,
  emptyValueOf,
  isVec3Schema,
  type RefTarget,
  refTargetOf,
  type StateRefValue,
  stringifyValue,
  type Value,
  type ValueSchema,
} from "@tukurium/eks";
import { RESOURCE_FIELD_KIND } from "@tukurium/repo-model";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useProject } from "./hooks";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import css from "./ValueInput.module.css";
import {
  countLabel,
  fieldChoices,
  fillValue,
  isInlineSchema,
  moveItem,
  newKey,
  optionIndex,
  parseTypedText,
  renameKey,
  schemaLabel,
  shapeMatches,
  stateRefOf,
  withoutKey,
  withoutUndefined,
} from "./valueEdit";

/** 参照で選べるもの */
export interface FieldChoices {
  materials: { id: string; name: string }[];
  /** states：その Entity に付いている KokoState の ID（KokoState の参照・フィールドの参照を選ぶのに使う） */
  entities: { id: string; name: string; states?: readonly string[] }[];
  /** 素材（GLB・画像・音声） */
  assets?: { id: string; name: string; kind: string }[];
}

interface Shared {
  choices: FieldChoices;
  disabled?: boolean | undefined;
}

interface InputProps<S extends ValueSchema = ValueSchema, V = Value> extends Shared {
  schema: S;
  value: V;
  onChange: (value: Value) => void;
  /** 欄の名前（`<label>`）と結び付ける。入れ子の中では付けない */
  id?: string | undefined;
  /** 読み上げ用の名前（「hand 0 rank」のように、外側からの道筋） */
  label: string;
}

type Kind<K extends ValueSchema["kind"]> = ValueSchema & { kind: K };

/**
 * 型（スキーマ）に合わせた、値 1 つ分の入力（ADR 0065）。レコード・リスト・マップは、
 * 中の値ごとにこの部品を重ねて出す。専用の入力がない型（Map・Set）は、値の形式の文字で直す。
 * 値は書き換えず、変えたあとの値をまるごと onChange に渡す。
 */
export function ValueInput(props: InputProps): ReactNode {
  const { schema, value } = props;
  if (!shapeMatches(schema, value)) return <Mismatch {...props} />;

  const target = refTargetOf(schema);
  if (target) return <RefInput {...props} target={target} />;
  const stateRef = stateRefOf(schema);
  if (stateRef) {
    const rest = { ...props, value: value as StateRefValue | undefined };
    return stateRef.ref.kind === "kokoRef" ? (
      <KokoRefInput {...rest} schema={stateRef.ref} optional={stateRef.optional} />
    ) : (
      <FieldRefInput {...rest} schema={stateRef.ref} optional={stateRef.optional} />
    );
  }

  switch (schema.kind) {
    case "number":
      return (
        <NumberInput
          id={props.id}
          label={props.label}
          value={value as number}
          disabled={props.disabled}
          onCommit={props.onChange}
        />
      );
    case "string":
      return (
        <TextInput
          id={props.id}
          label={props.label}
          value={value as string}
          disabled={props.disabled}
          onCommit={(text) => {
            props.onChange(text);
            return true;
          }}
        />
      );
    case "boolean":
      return (
        <input
          id={props.id}
          aria-label={props.label}
          type="checkbox"
          checked={value === true}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.checked)}
        />
      );
    case "bigint":
      return (
        <TextInput
          id={props.id}
          label={props.label}
          mono
          value={String(value)}
          disabled={props.disabled}
          onCommit={(text) => {
            try {
              props.onChange(BigInt(text.trim()));
              return true;
            } catch {
              return false;
            }
          }}
        />
      );
    case "Date":
      return (
        <TextInput
          id={props.id}
          label={props.label}
          mono
          value={dateText(value as Date)}
          disabled={props.disabled}
          onCommit={(text) => {
            const date = new Date(text.trim());
            if (Number.isNaN(date.getTime())) return false;
            props.onChange(date);
            return true;
          }}
        />
      );
    case "undefined":
      return <span className={css.none}>（なし）</span>;
    case "literal":
      return <code className={css.raw}>{String(schema.value)}</code>;
    case "color":
      return (
        <span className={ui.color}>
          <input
            id={props.id}
            aria-label={props.label}
            type="color"
            value={String(value)}
            disabled={props.disabled}
            onChange={(e) => props.onChange(e.target.value)}
          />
          <code className={ui.num}>{String(value).toUpperCase()}</code>
        </span>
      );
    case "union":
      return <UnionInput {...props} schema={schema} />;
    case "tuple":
      return isVec3Schema(schema) ? (
        <Vec3Input {...props} value={value as number[]} />
      ) : (
        <TupleInput {...props} schema={schema} value={value as Value[]} />
      );
    case "list":
      return <ListInput {...props} schema={schema} value={value as Value[]} />;
    case "record":
      return <RecordInput {...props} schema={schema} value={value as Record<string, Value>} />;
    case "map":
      return <MapInput {...props} schema={schema} value={value as Record<string, Value>} />;
    case "Map":
    case "Set":
      return <TextValueInput {...props} />;
    default:
      // 参照（ref・kokoRef・fieldRef）は、上で入力を決めている
      return null;
  }
}

/** 日時を、読めて打ち直せる文字にする（壊れた日時は空にする） */
function dateText(date: Date): string {
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** 型の大枠に合わない値。直す前に、空の値へ置き換えてもらう */
function Mismatch(props: InputProps) {
  return (
    <span className={css.stack}>
      <code className={css.raw}>{stringifyValue(props.value)}</code>
      <span className={css.warn}>型（{schemaLabel(props.schema)}）に合わない値です</span>
      {!props.disabled && (
        <button
          type="button"
          className={css.add}
          aria-label={`${props.label} を空の値にする`}
          onClick={() => props.onChange(emptyValueOf(props.schema))}
        >
          空の値にする
        </button>
      )}
    </span>
  );
}

/**
 * 値の形式の文字（タグ付きの JSON）で直す。型に合わない文字は保存せず、理由を出す。
 * 確定は、フォーカスを外すか Ctrl+Enter。Esc で元に戻す。
 */
export function TextValueInput(props: {
  schema?: ValueSchema | undefined;
  value: Value;
  onChange: (value: Value) => void;
  disabled?: boolean | undefined;
  id?: string | undefined;
  label: string;
}) {
  const shown = stringifyValue(props.value, 2);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(shown);
    setError(null);
  }, [shown]);
  const commit = () => {
    if (text === shown) return setError(null);
    const result = parseTypedText(text, props.schema);
    if (!result.ok) return setError(result.error);
    setError(null);
    props.onChange(result.value);
  };
  return (
    <span className={css.stack}>
      <textarea
        id={props.id}
        aria-label={`${props.label}（値の形式の文字）`}
        className={css.text}
        rows={Math.min(14, Math.max(2, text.split("\n").length))}
        spellCheck={false}
        value={text}
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit();
          if (e.key === "Escape") {
            setText(shown);
            setError(null);
          }
        }}
      />
      {error && (
        <span className={css.warn} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * 入れ子の中の 1 行：名前と入力。1 行に収まらない型は、見出しの下に枠を開いて出す。
 */
function Entry(
  props: InputProps & {
    /** 名前の所に出すもの（フィールドの名前・並びの番号・キーの入力） */
    name: ReactNode;
    /** 行の端に出す操作（上へ・下へ・消す） */
    actions?: ReactNode;
  },
) {
  const [open, setOpen] = useState(true);
  const { name, actions, ...input } = props;
  if (isInlineSchema(props.schema)) {
    return (
      <div className={css.entry}>
        <span className={css.name}>{name}</span>
        <ValueInput {...input} />
        {actions ? <span className={css.actions}>{actions}</span> : null}
      </div>
    );
  }
  return (
    <div className={css.group}>
      <div className={css.head}>
        <button
          type="button"
          className={css.fold}
          aria-expanded={open}
          aria-label={`${props.label} を${open ? "閉じる" : "開く"}`}
          onClick={() => setOpen(!open)}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className={css.name}>{name}</span>
        <span className={css.summary}>
          {countLabel(props.schema, props.value) || schemaLabel(props.schema)}
        </span>
        {actions ? <span className={css.actions}>{actions}</span> : null}
      </div>
      {open ? <ValueInput {...input} /> : null}
    </div>
  );
}

function ListInput(props: InputProps<Kind<"list">, Value[]>) {
  const { schema, value, onChange, disabled, label, choices } = props;
  return (
    <div className={css.nest}>
      {value.length === 0 && <span className={css.none}>（空）</span>}
      {value.map((item, i) => (
        <Entry
          // biome-ignore lint/suspicious/noArrayIndexKey: 並びの位置が、そのまま要素の身元
          key={i}
          name={<span className={css.index}>{i}</span>}
          label={`${label} ${i}`}
          schema={schema.item}
          value={item}
          choices={choices}
          disabled={disabled}
          onChange={(v) => onChange(value.map((x, j) => (j === i ? v : x)))}
          actions={
            disabled ? null : (
              <>
                <button
                  type="button"
                  className={css.act}
                  aria-label={`${label} ${i} を上へ`}
                  title="上へ"
                  disabled={i === 0}
                  onClick={() => onChange(moveItem(value, i, i - 1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={css.act}
                  aria-label={`${label} ${i} を下へ`}
                  title="下へ"
                  disabled={i === value.length - 1}
                  onClick={() => onChange(moveItem(value, i, i + 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={css.act}
                  aria-label={`${label} ${i} を消す`}
                  title="消す"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </>
            )
          }
        />
      ))}
      {!disabled && (
        <button
          type="button"
          className={css.add}
          aria-label={`${label} に足す`}
          onClick={() => onChange([...value, fillValue(schema.item)])}
        >
          ＋ 足す
        </button>
      )}
    </div>
  );
}

function TupleInput(props: InputProps<Kind<"tuple">, Value[]>) {
  const { schema, value, onChange, label } = props;
  return (
    <div className={css.nest}>
      {schema.items.map((item, i) => (
        <Entry
          // biome-ignore lint/suspicious/noArrayIndexKey: 並びの位置が、そのまま要素の身元
          key={i}
          name={<span className={css.index}>{i}</span>}
          label={`${label} ${i}`}
          schema={item}
          value={value[i]}
          choices={props.choices}
          disabled={props.disabled}
          onChange={(v) => onChange(value.map((x, j) => (j === i ? v : x)))}
        />
      ))}
    </div>
  );
}

function RecordInput(props: InputProps<Kind<"record">, Record<string, Value>>) {
  const { schema, value, onChange, disabled, label } = props;
  return (
    <div className={css.nest}>
      {schema.fields.length === 0 && <span className={css.none}>（フィールドなし）</span>}
      {schema.fields.map((f) => {
        const fieldLabel = `${label} ${f.name}`;
        const name = <span title={f.name}>{f.name}</span>;
        // 省略できるフィールド：ないときは「（なし）」と足す印、あるときは消す印を出す
        if (f.optional && value[f.name] === undefined) {
          return (
            <div key={f.name} className={css.entry}>
              <span className={css.name}>{name}</span>
              <span className={css.none}>（なし）</span>
              {!disabled && (
                <span className={css.actions}>
                  <button
                    type="button"
                    className={css.act}
                    aria-label={`${fieldLabel} を足す`}
                    title="足す"
                    onClick={() => onChange({ ...value, [f.name]: fillValue(f.schema) })}
                  >
                    ＋
                  </button>
                </span>
              )}
            </div>
          );
        }
        return (
          <Entry
            key={f.name}
            name={name}
            label={fieldLabel}
            schema={f.optional ? withoutUndefined(f.schema) : f.schema}
            value={value[f.name]}
            choices={props.choices}
            disabled={disabled}
            onChange={(v) => onChange({ ...value, [f.name]: v })}
            actions={
              f.optional && !disabled ? (
                <button
                  type="button"
                  className={css.act}
                  aria-label={`${fieldLabel} を消す`}
                  title="消す"
                  onClick={() => onChange(withoutKey(value, f.name) as Record<string, Value>)}
                >
                  ✕
                </button>
              ) : null
            }
          />
        );
      })}
    </div>
  );
}

/** 文字のキーから値へのマップ（`Record<string, V>`）。キーの名前を変える・足す・消す */
function MapInput(props: InputProps<Kind<"map">, Record<string, Value>>) {
  const { schema, value, onChange, disabled, label } = props;
  const keys = Object.keys(value);
  return (
    <div className={css.nest}>
      {keys.length === 0 && <span className={css.none}>（空）</span>}
      {keys.map((key) => (
        <Entry
          key={key}
          name={
            <TextInput
              label={`${label} のキー ${key}`}
              mono
              value={key}
              disabled={disabled}
              onCommit={(to) => {
                const next = renameKey(value, key, to);
                if (next) onChange(next as Record<string, Value>);
                return next !== null;
              }}
            />
          }
          label={`${label} ${key}`}
          schema={schema.value}
          value={value[key]}
          choices={props.choices}
          disabled={disabled}
          onChange={(v) => onChange({ ...value, [key]: v })}
          actions={
            disabled ? null : (
              <button
                type="button"
                className={css.act}
                aria-label={`${label} ${key} を消す`}
                title="消す"
                onClick={() => onChange(withoutKey(value, key) as Record<string, Value>)}
              >
                ✕
              </button>
            )
          }
        />
      ))}
      {!disabled && (
        <button
          type="button"
          className={css.add}
          aria-label={`${label} に足す`}
          onClick={() => onChange({ ...value, [newKey(value)]: fillValue(schema.value) })}
        >
          ＋ 足す
        </button>
      )}
    </div>
  );
}

/** いくつかの型のどれか。どの型かを選び、その型の入力を下に出す */
function UnionInput(props: InputProps<Kind<"union">>) {
  const { schema, value, onChange } = props;
  const index = optionIndex(schema, value);
  const option = schema.options[index];
  const select = (
    <select
      id={props.id}
      aria-label={props.label}
      className={ui.select}
      value={index}
      disabled={props.disabled}
      onChange={(e) => {
        const next = schema.options[Number(e.target.value)];
        if (next) onChange(emptyValueOf(next));
      }}
    >
      {schema.options.map((o, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 選択肢は、型の中での位置で見分ける
        <option key={i} value={i}>
          {schemaLabel(o)}
        </option>
      ))}
    </select>
  );
  // 選ぶだけで値が決まる選択肢（「なし」と、文字・数のリテラル）には、下の入力が要らない
  if (!option || option.kind === "undefined" || option.kind === "literal") return select;
  return (
    <div className={css.stack}>
      {select}
      <ValueInput {...props} id={undefined} schema={option} />
    </div>
  );
}

/** Entity・リソースの参照。「なし」にできるのは、型が undefined を受け入れるときだけ */
function RefInput(props: InputProps & { target: RefTarget }) {
  const { target, value, onChange } = props;
  const assets = props.choices.assets ?? [];
  const kind = target === "entity" ? null : RESOURCE_FIELD_KIND[target];
  const options =
    target === "entity"
      ? props.choices.entities
      : kind === "material"
        ? props.choices.materials
        : assets.filter((a) => a.kind === kind);
  const optional = acceptsUndefined(props.schema);
  return (
    <select
      id={props.id}
      aria-label={props.label}
      className={ui.select}
      value={typeof value === "string" ? value : ""}
      disabled={props.disabled}
      onChange={(e) => {
        if (e.target.value !== "") onChange(e.target.value);
        else if (optional) onChange(undefined);
      }}
    >
      <option value="" disabled={!optional}>
        {optional ? "（なし）" : "（選んでください）"}
      </option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

/** KokoState の定義を ID で引く（制作データが変わったら作り直す） */
function useKokoDefs() {
  const project = useProject();
  const rev = useWorkspace((s) => s.rev);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は制作データが変わった合図
  return useMemo(() => {
    const registry = project.registry();
    return (id: string) => registry.get(id);
  }, [project, rev]);
}

interface StateRefProps<K extends "kokoRef" | "fieldRef">
  extends InputProps<Kind<K>, StateRefValue | undefined> {
  /** 「なし」にできるか（型が undefined を受け入れるか） */
  optional: boolean;
}

/**
 * KokoState の参照（「的 3 の Health」）。指せる KokoState が型で決まっていれば、
 * それを持つ Entity だけを選べる。決まっていなければ、Entity を選んでから KokoState を選ぶ。
 */
function KokoRefInput(props: StateRefProps<"kokoRef">) {
  const { schema, value, optional, onChange } = props;
  const defOf = useKokoDefs();
  const all = props.choices.entities;
  const entities = all.filter((e) =>
    schema.koko === undefined ? (e.states?.length ?? 0) > 0 : e.states?.includes(schema.koko),
  );
  const entity = value?.entity ?? "";
  const current = all.find((e) => e.id === entity);
  const attached = current?.states ?? [];
  const kokoName = (id: string) => defOf(id)?.name ?? "（見つかりません）";
  return (
    <span className={css.stack}>
      <select
        id={props.id}
        aria-label={props.label}
        className={ui.select}
        value={entity}
        disabled={props.disabled}
        onChange={(e) => {
          const id = e.target.value;
          if (id === "") {
            if (optional) onChange(undefined);
            return;
          }
          const states = entities.find((x) => x.id === id)?.states ?? [];
          const koko =
            schema.koko ?? (value && states.includes(value.koko) ? value.koko : states[0]);
          if (koko !== undefined) onChange({ entity: id, koko });
        }}
      >
        <option value="" disabled={!optional}>
          {optional ? "（なし）" : "（選んでください）"}
        </option>
        {entity !== "" && !entities.some((e) => e.id === entity) && (
          <option value={entity}>
            {current ? `${current.name}（指せません）` : "（見つかりません）"}
          </option>
        )}
        {entities.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {schema.koko !== undefined ? (
        <span className={css.summary}>{kokoName(schema.koko)} を指します</span>
      ) : (
        value &&
        entity !== "" && (
          <select
            aria-label={`${props.label} の KokoState`}
            className={ui.select}
            value={value.koko}
            disabled={props.disabled}
            onChange={(e) => onChange({ entity, koko: e.target.value })}
          >
            {!attached.includes(value.koko) && (
              <option value={value.koko}>{kokoName(value.koko)}（付いていません）</option>
            )}
            {attached.map((k) => (
              <option key={k} value={k}>
                {kokoName(k)}
              </option>
            ))}
          </select>
        )
      )}
    </span>
  );
}

/**
 * フィールドの参照（「的 3 の Health.hp」）。Entity を選んでから、フィールドを選ぶ。
 * 選べるのは、型で指せるフィールドだけ（`FieldRef<number>` では、文字のフィールドは出ない）。
 */
function FieldRefInput(props: StateRefProps<"fieldRef">) {
  const { schema, value, optional, onChange } = props;
  const defOf = useKokoDefs();
  const schemas = useWorkspace((s) => s.fieldSchemas);
  const all = props.choices.entities;
  const entities = all
    .map((e) => ({ ...e, fields: fieldChoices(e.states ?? [], defOf, schemas, schema.value) }))
    .filter((e) => e.fields.length > 0);
  const entity = value?.entity ?? "";
  const current = entities.find((e) => e.id === entity);
  const fields = current?.fields ?? [];
  const picked = value
    ? fields.findIndex((f) => f.koko === value.koko && f.field === value.field)
    : -1;
  /** いま指しているフィールドの名前（選べないものを指しているときに出す） */
  const currentName = () => {
    if (!value) return "";
    const def = defOf(value.koko);
    const field = def?.fields.find((f) => f.id === value.field);
    return def && field ? `${def.name}.${field.name}` : "（見つかりません）";
  };
  return (
    <span className={css.stack}>
      <select
        id={props.id}
        aria-label={props.label}
        className={ui.select}
        value={entity}
        disabled={props.disabled}
        onChange={(e) => {
          const id = e.target.value;
          if (id === "") {
            if (optional) onChange(undefined);
            return;
          }
          const next = entities.find((x) => x.id === id);
          // 同じフィールドが新しい Entity にもあれば、それを指したままにする
          const field =
            next?.fields.find((f) => f.koko === value?.koko && f.field === value?.field) ??
            next?.fields[0];
          if (field) onChange({ entity: id, koko: field.koko, field: field.field });
        }}
      >
        <option value="" disabled={!optional}>
          {optional ? "（なし）" : "（選んでください）"}
        </option>
        {entity !== "" && !current && (
          <option value={entity}>
            {all.some((e) => e.id === entity) ? currentName() : "（見つかりません）"}
          </option>
        )}
        {entities.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {value && current && (
        <select
          aria-label={`${props.label} のフィールド`}
          className={ui.select}
          value={picked}
          disabled={props.disabled}
          onChange={(e) => {
            const field = fields[Number(e.target.value)];
            if (field) onChange({ entity, koko: field.koko, field: field.field });
          }}
        >
          {picked < 0 && <option value={-1}>{currentName()}（指せません）</option>}
          {fields.map((f, i) => (
            <option key={`${f.koko}/${f.field}`} value={i}>
              {f.label}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

function Vec3Input(props: InputProps<ValueSchema, number[]>) {
  const v = props.value;
  return (
    <span className={ui.vec3}>
      {(["X", "Y", "Z"] as const).map((axis, i) => (
        // 軸ごとに色を付けた印を、入力欄の頭に出す（X 赤・Y 緑・Z 青）
        <span key={axis} className={ui.axisBox} data-axis={axis}>
          <span className={ui.axisTag} aria-hidden="true">
            {axis}
          </span>
          <NumberInput
            id={i === 0 ? props.id : undefined}
            label={`${props.label} ${axis}`}
            value={v[i] ?? 0}
            disabled={props.disabled}
            onCommit={(n) => {
              const next = [...v];
              next[i] = n;
              props.onChange(next);
            }}
          />
        </span>
      ))}
    </span>
  );
}

/**
 * 数の入力。入力中の途中の文字（「1.」「-」など）を壊さないよう、確定（Enter・フォーカスを外す）で反映する。
 */
export function NumberInput(props: {
  id?: string | undefined;
  label?: string | undefined;
  value: number;
  disabled?: boolean | undefined;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(format(props.value));
  useEffect(() => setText(format(props.value)), [props.value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n)) {
      if (n !== props.value) props.onCommit(n);
    } else {
      setText(format(props.value));
    }
  };
  return (
    <input
      id={props.id}
      aria-label={props.label}
      className={`${ui.input} ${ui.num}`}
      inputMode="decimal"
      value={text}
      disabled={props.disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setText(format(props.value));
      }}
    />
  );
}

/**
 * 文字の入力。確定（Enter・フォーカスを外す）で反映する。
 * onCommit が false を返したら（受け取れない文字だったら）、元の文字に戻す。
 */
export function TextInput(props: {
  id?: string | undefined;
  label?: string | undefined;
  value: string;
  mono?: boolean;
  disabled?: boolean | undefined;
  onCommit: (text: string) => boolean;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const commit = () => {
    if (text !== props.value && !props.onCommit(text)) setText(props.value);
  };
  return (
    <input
      id={props.id}
      aria-label={props.label}
      className={props.mono ? `${ui.input} ${ui.num}` : ui.input}
      value={text}
      disabled={props.disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setText(props.value);
      }}
    />
  );
}

function format(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 10000) / 10000);
}
