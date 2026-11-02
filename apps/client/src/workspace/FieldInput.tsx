import type { FieldDef, FieldValue, Vec3 } from "@tukurium/eks";
import { BUILTIN, MESH_SHAPES, RIGID_BODY_TYPES } from "@tukurium/repo-model";
import { useEffect, useId, useState } from "react";
import ui from "./ui.module.css";

export interface FieldChoices {
  materials: { id: string; name: string }[];
  entities: { id: string; name: string }[];
}

/** 文字列で選ぶ Built-in のフィールド */
const ENUMS: Record<string, readonly string[]> = {
  [`${BUILTIN.Mesh}/shape`]: MESH_SHAPES,
  [`${BUILTIN.RigidBody}/type`]: RIGID_BODY_TYPES,
};

const SHAPE_LABEL: Record<string, string> = {
  box: "ボックス",
  sphere: "球",
  cylinder: "円柱",
  capsule: "カプセル",
  plane: "平面",
  fixed: "固定",
  dynamic: "物理で動く",
  kinematic: "スクリプトで動かす",
};

/**
 * KokoState のフィールド 1 つ分の入力。型ごとに入力部品を変える。
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

  let control: React.ReactNode;
  if (enumValues) {
    control = (
      <select
        id={id}
        className={ui.select}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {enumValues.map((v) => (
          <option key={v} value={v}>
            {SHAPE_LABEL[v] ?? v}
          </option>
        ))}
      </select>
    );
  } else {
    switch (field.type) {
      case "number":
        control = (
          <NumberInput id={id} value={Number(value)} disabled={disabled} onCommit={onChange} />
        );
        break;
      case "boolean":
        control = (
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
        );
        break;
      case "string":
        control = (
          <TextInput id={id} value={String(value ?? "")} disabled={disabled} onCommit={onChange} />
        );
        break;
      case "color":
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
        break;
      case "vec3": {
        const v = (Array.isArray(value) ? value : [0, 0, 0]) as Vec3;
        control = (
          <span className={ui.vec3}>
            {(["X", "Y", "Z"] as const).map((axis, i) => (
              <NumberInput
                key={axis}
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
            ))}
          </span>
        );
        break;
      }
      case "resource":
      case "entity": {
        const options =
          field.type === "resource" ? props.choices.materials : props.choices.entities;
        control = (
          <select
            id={id}
            className={ui.select}
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">（なし）</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        );
        break;
      }
    }
  }

  return (
    <div className={ui.row}>
      <label htmlFor={id} className={ui.label} title={field.name}>
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
