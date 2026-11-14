import { conformValue, type FieldDef, type FieldValue, schemaOfField } from "@tukurium/eks";
import { BUILTIN, COLLIDER_SHAPES, MESH_SHAPES, RIGID_BODY_TYPES } from "@tukurium/repo-model";
import { useId, useState } from "react";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import { type FieldChoices, TextValueInput, ValueInput } from "./ValueInput";
import css from "./ValueInput.module.css";
import { countLabel, isInlineSchema } from "./valueEdit";

export type { FieldChoices } from "./ValueInput";

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
  [`${BUILTIN.RigidBody}/lockMoveX`]: "オンにすると X の向きへ動きません（ワールドの軸）",
  [`${BUILTIN.RigidBody}/lockMoveY`]: "オンにすると Y の向きへ動きません（ワールドの軸）",
  [`${BUILTIN.RigidBody}/lockMoveZ`]: "オンにすると Z の向きへ動きません（ワールドの軸）",
  [`${BUILTIN.RigidBody}/lockRotateX`]: "オンにすると X 軸まわりに回りません（ワールドの軸）",
  [`${BUILTIN.RigidBody}/lockRotateY`]: "オンにすると Y 軸まわりに回りません（ワールドの軸）",
  [`${BUILTIN.RigidBody}/lockRotateZ`]: "オンにすると Z 軸まわりに回りません（ワールドの軸）",
};

/**
 * KokoState のフィールド 1 つ分の入力。型（スキーマ）ごとに入力部品を変える（`ValueInput`）。
 * レコード・リスト・マップなど、1 行に収まらない型は、名前の行の下に枠を開いて出す。
 * そこでは、値の形式の文字で直すこともできる（専用の入力がない型と、型が分からないフィールドは、いつも文字）。
 */
export function FieldInput(props: {
  koko: string;
  field: FieldDef;
  value: FieldValue;
  choices: FieldChoices;
  disabled?: boolean;
  onChange: (value: FieldValue) => void;
}) {
  const { field, disabled, onChange } = props;
  const id = useId();
  const [open, setOpen] = useState(true);
  const [asText, setAsText] = useState(false);
  const enumValues = ENUMS[`${props.koko}/${field.id}`];

  const schemas = useWorkspace((st) => st.fieldSchemas);
  // 型の文から決まる入力。TypeScript で作ったスキーマがあればそれ、なければ型の文から分かるもの
  const schema = schemaOfField(schemas, props.koko, field);
  // 型の定義を変えたあとの値は、足りないフィールドを埋めた形で見せる（値の確かめ・実行と同じ形）
  const value = (schema ? conformValue(schema, props.value) : props.value) as FieldValue;

  const label = (
    <label
      htmlFor={id}
      className={ui.label}
      title={FIELD_TITLE[`${props.koko}/${field.id}`] ?? field.name}
    >
      {field.name}
    </label>
  );

  if (enumValues) {
    return (
      <div className={ui.field}>
        {label}
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
      </div>
    );
  }

  const input = { value, onChange, disabled, choices: props.choices, label: field.name };
  if (schema && isInlineSchema(schema)) {
    return (
      <div className={ui.field}>
        {label}
        <ValueInput {...input} id={id} schema={schema} />
      </div>
    );
  }

  // 専用の入力がある型か（Map・Set と、型エラーで形が分からないフィールドには、ない）
  const structured = schema !== undefined && schema.kind !== "Map" && schema.kind !== "Set";
  return (
    <div className={css.blockField} data-block="">
      <div className={ui.field}>
        {label}
        <span className={css.blockHead}>
          <button
            type="button"
            id={open && (asText || !structured) ? undefined : id}
            className={css.fold}
            aria-expanded={open}
            aria-label={`${field.name} を${open ? "閉じる" : "開く"}`}
            onClick={() => setOpen(!open)}
          >
            {open ? "▾" : "▸"}
          </button>
          <span className={css.summary} title={field.type}>
            {(schema && countLabel(schema, value)) || field.type}
          </span>
          {structured && (
            <button
              type="button"
              className={css.mode}
              aria-pressed={asText}
              aria-label={`${field.name} を文字で直す`}
              title="値の形式の文字で直す"
              onClick={() => setAsText(!asText)}
            >
              {"{ }"}
            </button>
          )}
        </span>
      </div>
      {open &&
        (structured && !asText ? (
          <ValueInput {...input} schema={schema} />
        ) : (
          <TextValueInput {...input} id={id} schema={schema} />
        ))}
    </div>
  );
}
