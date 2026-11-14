import {
  cloneValue,
  conformValue,
  emptyValueOf,
  type FieldDef,
  type KokoStateDef,
  knownSchema,
  validateValue,
} from "@tukurium/eks";
import { BASIC_FIELD_TYPES, basicFieldType } from "@tukurium/repo-model";
import { useEffect, useState } from "react";
import { ChangeMark, MarkedLine } from "./ChangeMark";
import type { ChangeKind } from "./changeMarks";
import { FieldInput } from "./FieldInput";
import { useProject } from "./hooks";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";
import css from "./ValueInput.module.css";

/** 型の一覧で「TypeScript で書く」を選んだときの値（型の文とは重ならない文字にする） */
const WRITE_TYPE = "\u0000typescript";

/**
 * KokoState の定義の、フィールド 1 つ分：名前・型・初期値（ADR 0065）。
 * 型は、一覧から選ぶか、TypeScript の型の文で書く。一覧にない型のフィールドは、いつも型の文を出す。
 */
export function KokoFieldRow(props: {
  koko: KokoStateDef;
  field: FieldDef;
  mark: ChangeKind | null;
  editing: boolean;
  onPatch: (patch: Partial<FieldDef>) => void;
  onDelete: () => void;
}) {
  const { koko, field: f, editing } = props;
  const project = useProject();
  const materials = project.materials();
  const basic = basicFieldType(f.type);
  const [writing, setWriting] = useState(false);
  const target = { entry: `koko:${koko.id}`, part: `field:${f.id}` };

  // 型の文を書き換えたあと、その型で確かめ直した結果を待っている（書き換える前の版を覚えておく）
  const [waiting, setWaiting] = useState<{ type: string; rev: number } | null>(null);
  const checked = useWorkspace((s) => s.typeProblems.observedVersion);
  const schema = useWorkspace((s) => s.fieldSchemas[koko.id]?.[f.id]);
  const typeError = useWorkspace(
    (s) =>
      s.typeProblems.diagnostics.find(
        (d) =>
          d.subject.id === koko.id &&
          d.location?.kind === "property" &&
          d.location.path[0] === f.id &&
          d.location.path[1] === "type",
      )?.message,
  );

  useEffect(() => {
    if (!waiting) return;
    if (waiting.type !== f.type) return setWaiting(null);
    // まだ、書き換える前の型で確かめた結果
    if (checked === null || checked <= waiting.rev) return;
    setWaiting(null);
    if (!schema || validateValue(schema, conformValue(schema, f.default)) === null) return;
    // 新しい型に、前の型の初期値が合わない：初期値と、型を変えたときにその初期値になった Entity の値を、
    // 新しい型の空の値にする
    const empty = emptyValueOf(schema);
    const def = project.kokostate(koko.id);
    if (!def) return;
    try {
      project.transact(() => {
        project.updateKokoState({
          ...def,
          fields: def.fields.map((x) => (x.id === f.id ? { ...x, default: empty } : x)),
        });
        for (const e of project.entities()) {
          const values = e.states[koko.id];
          if (values && validateValue(schema, conformValue(schema, values[f.id])) !== null)
            project.setField(e.id, koko.id, f.id, cloneValue(empty));
        }
      });
    } catch {
      // 直せなくても、初期値の欄の「空の値にする」で直せる
    }
  }, [waiting, checked, schema, f, koko.id, project]);

  const commitType = (type: string) => {
    // よく使う型（と `| undefined`）は、TypeScript を待たずに初期値を合わせられる
    const known = knownSchema(type);
    if (known) {
      const fits = validateValue(known, f.default) === null;
      props.onPatch(fits ? { type } : { type, default: emptyValueOf(known) });
      return;
    }
    setWaiting({ type, rev: useWorkspace.getState().rev });
    props.onPatch({ type });
  };

  const ts = writing || !basic;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 6 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "8px minmax(0, 1fr) 128px 26px",
          gap: 6,
          alignItems: "center",
        }}
      >
        <ChangeMark kind={props.mark} target={target} />
        <input
          key={`${f.id}:${f.name}`}
          className={ui.input}
          aria-label="フィールド名"
          defaultValue={f.name}
          disabled={!editing}
          onBlur={(e) => e.target.value !== f.name && props.onPatch({ name: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <select
          className={ui.select}
          aria-label={`${f.name} の型`}
          title={f.type}
          value={ts || !basic ? WRITE_TYPE : basic.type}
          disabled={!editing}
          onChange={(e) => {
            if (e.target.value === WRITE_TYPE) return setWriting(true);
            const t = BASIC_FIELD_TYPES.find((x) => x.type === e.target.value);
            if (!t) return;
            setWriting(false);
            props.onPatch({ type: t.type, default: structuredClone(t.default) });
          }}
        >
          {BASIC_FIELD_TYPES.map((t) => (
            <option key={t.key} value={t.type}>
              {t.label}
            </option>
          ))}
          <option value={WRITE_TYPE}>TypeScript で書く</option>
        </select>
        <button
          type="button"
          className={ui.iconBtn}
          aria-label={`${f.name} を削除`}
          disabled={!editing}
          onClick={props.onDelete}
        >
          ✕
        </button>
      </div>
      {ts && (
        <div className={css.stack} style={{ paddingLeft: 14 }}>
          <TypeTextInput name={f.name} value={f.type} disabled={!editing} onCommit={commitType} />
          {typeError && <span className={css.warn}>{typeError}</span>}
        </div>
      )}
      <MarkedLine kind={props.mark} target={target}>
        <FieldInput
          koko={koko.id}
          field={{ ...f, name: "初期値" }}
          value={f.default}
          choices={{ materials, entities: [] }}
          disabled={!editing}
          onChange={(v) => props.onPatch({ default: v })}
        />
      </MarkedLine>
    </div>
  );
}

/**
 * 型の文（TypeScript の型の書き方）の入力。確定は Enter かフォーカスを外す。
 * 改行は Shift+Enter。Esc で元に戻す。
 */
function TypeTextInput(props: {
  name: string;
  value: string;
  disabled: boolean;
  onCommit: (type: string) => void;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const commit = () => {
    const next = text.trim();
    if (next === "") return setText(props.value);
    if (next !== props.value) props.onCommit(next);
  };
  return (
    <textarea
      className={css.text}
      aria-label={`${props.name} の型（TypeScript）`}
      placeholder="例：{ suit: string; rank: number }[]"
      rows={Math.min(8, Math.max(1, text.split("\n").length))}
      spellCheck={false}
      value={text}
      disabled={props.disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") setText(props.value);
      }}
    />
  );
}
