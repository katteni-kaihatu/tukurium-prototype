import {
  acceptsUndefined,
  type FieldDef,
  type FieldValue,
  isVec3Schema,
  refTargetOf,
  schemaOfField,
  stringifyValue,
  type Vec3,
} from "@tukurium/eks";
import {
  BUILTIN,
  COLLIDER_SHAPES,
  MESH_SHAPES,
  RESOURCE_FIELD_KIND,
  RIGID_BODY_TYPES,
} from "@tukurium/repo-model";
import { useEffect, useId, useState } from "react";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

export interface FieldChoices {
  materials: { id: string; name: string }[];
  entities: { id: string; name: string }[];
  /** 素材（GLB・画像・音声） */
  assets?: { id: string; name: string; kind: string }[];
}

/** 文字列で選ぶ Built-in のフィールド */
const ENUMS: Record<string, readonly string[]> = {
  [`${BUILTIN.Mesh}/shape`]: MESH_SHAPES,
  [`${BUILTIN.Collider}/shape`]: COLLIDER_SHAPES,
  [`${BUILTIN.RigidBody}/type`]: RIGID_BODY_TYPES,
};

const SHAPE_LABEL: Record<string, string> = {
  mesh: "見た目に合わせる",
  box: "ボックス",
  sphere: "球",
  cylinder: "円柱",
  capsule: "カプセル",
  plane: "平面",
  fixed: "固定",
  dynamic: "物理で動く",
  kinematic: "スクリプトで動かす",
};

/** 欄の名前に重ねたときの説明 */
const FIELD_TITLE: Record<string, string> = {
  [`${BUILTIN.Collider}/shape`]: "見た目に合わせるときは Mesh の形を使います",
  [`${BUILTIN.Collider}/size`]: "0 のときは見た目の大きさです。単位はメートル",
  [`${BUILTIN.Collider}/offset`]: "Entity の中心からのずれ（メートル）",
  [`${BUILTIN.Collider}/sensor`]: "オンにすると押し返さず、当たったことだけが届きます",
  [`${BUILTIN.Collider}/friction`]: "大きいほど滑りにくい",
  [`${BUILTIN.Collider}/restitution`]: "大きいほど跳ねる。0 で跳ねない",
  [`${BUILTIN.RigidBody}/type`]: "物理で動く・スクリプトで動かす・固定",
  [`${BUILTIN.RigidBody}/mass`]: "重さ（kg）。形では変わりません",
  [`${BUILTIN.RigidBody}/gravityScale`]: "0 にすると落ちません",
  [`${BUILTIN.RigidBody}/linearDamping`]: "大きいほどすぐ止まります",
  [`${BUILTIN.RigidBody}/angularDamping`]: "回転が止まる速さ",
  [`${BUILTIN.RigidBody}/linvel`]: "速度（メートル/秒）。実行が書き換えることがあります",
  [`${BUILTIN.RigidBody}/angvel`]: "回転の速度（ラジアン/秒）",
  [`${BUILTIN.RigidBody}/ccd`]: "速い物が薄い床をすり抜けないようにします",
};

/**
 * KokoState のフィールド 1 つ分の入力。型（スキーマ）ごとに入力部品を変える。
 * 数値は入力中の途中の文字（「1.」「-」など）を壊さないよう、確定（Enter・フォーカスを外す）で反映する。
 */
export function FieldInput(props: {
  koko: string;
  field: FieldDef;
  value: FieldValue;
  choices: FieldChoices;
  disabled?: boolean;
  onChange: (value: FieldValue) => void;
}) {
  const { field, value, disabled, onChange } = props;
  const id = useId();
  const enumValues = ENUMS[`${props.koko}/${field.id}`];

  const schemas = useWorkspace((st) => st.fieldSchemas);
  // 型の文から決まる入力。TypeScript で作ったスキーマがあればそれ、なければ型の文から分かるもの
  const schema = schemaOfField(schemas, props.koko, field);
  const refTarget = schema ? refTargetOf(schema) : undefined;
  const choicesOfLiterals =
    schema?.kind === "union" &&
    schema.options.every((o) => o.kind === "literal" && typeof o.value === "string")
      ? schema.options.map((o) => String((o as { value: unknown }).value))
      : undefined;

  let control: React.ReactNode;
  if (enumValues || choicesOfLiterals) {
    control = (
      <select
        id={id}
        className={ui.select}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {(enumValues ?? choicesOfLiterals ?? []).map((v) => (
          <option key={v} value={v}>
            {SHAPE_LABEL[v] ?? v}
          </option>
        ))}
      </select>
    );
  } else if (schema?.kind === "number") {
    control = <NumberInput id={id} value={Number(value)} disabled={disabled} onCommit={onChange} />;
  } else if (schema?.kind === "boolean") {
    control = (
      <input
        id={id}
        type="checkbox"
        checked={Boolean(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  } else if (schema?.kind === "string") {
    control = (
      <TextInput id={id} value={String(value ?? "")} disabled={disabled} onCommit={onChange} />
    );
  } else if (schema?.kind === "color") {
    control = (
      <span className={ui.color}>
        <input
          id={id}
          type="color"
          value={String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <code className={ui.num}>{String(value).toUpperCase()}</code>
      </span>
    );
  } else if (schema && isVec3Schema(schema)) {
    const v = (Array.isArray(value) ? value : [0, 0, 0]) as Vec3;
    control = (
      <span className={ui.vec3}>
        {(["X", "Y", "Z"] as const).map((axis, i) => (
          // 軸ごとに色を付けた印を、入力欄の頭に出す（X 赤・Y 緑・Z 青）
          <span key={axis} className={ui.axisBox} data-axis={axis}>
            <span className={ui.axisTag} aria-hidden="true">
              {axis}
            </span>
            <NumberInput
              id={i === 0 ? id : undefined}
              label={`${field.name} ${axis}`}
              value={v[i] ?? 0}
              disabled={disabled}
              onCommit={(n) => {
                const next = [...v] as Vec3;
                next[i] = n;
                onChange(next);
              }}
            />
          </span>
        ))}
      </span>
    );
  } else if (schema && refTarget) {
    const assets = props.choices.assets ?? [];
    const kind = refTarget === "entity" ? null : RESOURCE_FIELD_KIND[refTarget];
    const options =
      refTarget === "entity"
        ? props.choices.entities
        : kind === "material"
          ? props.choices.materials
          : assets.filter((a) => a.kind === kind);
    // 「なし」にできるのは、型が undefined を受け入れるときだけ（`EntityRef | undefined`）
    const optional = acceptsUndefined(schema);
    control = (
      <select
        id={id}
        className={ui.select}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
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
  } else {
    // 専用の入力がまだない型（リスト・レコードなど）と、型エラーで形が分からないフィールドは、
    // 値を保存する形（タグ付きの JSON）の文字で見せる
    control = (
      <code id={id} className={ui.num} title={field.type} style={{ overflowWrap: "anywhere" }}>
        {stringifyValue(value)}
      </code>
    );
  }

  return (
    <div className={ui.row}>
      <label
        htmlFor={id}
        className={ui.label}
        title={FIELD_TITLE[`${props.koko}/${field.id}`] ?? field.name}
      >
        {field.name}
      </label>
      {control}
    </div>
  );
}

function NumberInput(props: {
  id?: string;
  label?: string;
  value: number;
  disabled?: boolean;
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

function TextInput(props: {
  id: string;
  value: string;
  disabled?: boolean;
  onCommit: (s: string) => void;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <input
      id={props.id}
      className={ui.input}
      value={text}
      disabled={props.disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== props.value && props.onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && text !== props.value) props.onCommit(text);
      }}
    />
  );
}

function format(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 10000) / 10000);
}
