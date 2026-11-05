import {
  MAX_WORK_TAG_LENGTH,
  MAX_WORK_TAGS,
  splitTagDraft,
  workTagsSchema,
} from "@tukurium/shared";
import { useEffect, useId, useState } from "react";
import { useApp } from "../app/store";
import type { Work } from "../net/api";
import { saveWorkTags } from "./catalogStore";
import styles from "./WorkTags.module.css";

export function WorkTags({
  tags = [],
  onSelect,
}: {
  tags?: string[];
  onSelect?: (tag: string) => void;
}) {
  if (!tags.length) return null;
  return (
    <div className={styles.tags}>
      {tags.map((tag) =>
        onSelect ? (
          <button
            type="button"
            className={styles.tag}
            key={tag}
            onClick={() => onSelect(tag)}
            aria-label={`タグ「${tag}」で絞り込む`}
          >
            {tag}
          </button>
        ) : (
          <span className={styles.tag} key={tag}>
            {tag}
          </span>
        ),
      )}
    </div>
  );
}

export function PublicTagsField({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  const invalid = !workTagsSchema.safeParse(splitTagDraft(value)).success;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>公開タグ</label>
      <input
        id={id}
        value={value}
        maxLength={MAX_WORK_TAGS * (MAX_WORK_TAG_LENGTH + 2)}
        onChange={(event) => onChange(event.target.value)}
        placeholder="ゲーム, みんなで遊ぶ"
        aria-describedby={`${id}-help`}
        aria-invalid={invalid || undefined}
      />
      <small id={`${id}-help`} className={invalid ? styles.error : undefined}>
        カンマで区切って{MAX_WORK_TAGS}個まで。1個{MAX_WORK_TAG_LENGTH}文字以内。
      </small>
    </div>
  );
}

export function WorkTagsEditor({ work, onSaved }: { work: Work; onSaved?: () => void }) {
  const me = useApp((s) => s.me?.id);
  const [editing, setEditing] = useState(false);
  const saved = (work.tags ?? []).join(", ");
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(saved);
    setEditing(false);
    setError(null);
  }, [saved]);
  const parsed = workTagsSchema.safeParse(splitTagDraft(draft));
  return (
    <section className={styles.editor} aria-label="公開タグ">
      <div className={styles.heading}>
        <strong>公開タグ</strong>
        {me === work.owner && !editing && (
          <button type="button" onClick={() => setEditing(true)}>
            タグを編集
          </button>
        )}
      </div>
      {!editing ? (
        <>
          <WorkTags tags={work.tags} />
          {!work.tags?.length && <small>タグはまだありません。</small>}
        </>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!parsed.success || busy) return;
            setBusy(true);
            setError(null);
            try {
              await saveWorkTags(work.id, parsed.data);
              setEditing(false);
              onSaved?.();
            } catch (e) {
              setError(e instanceof Error ? e.message : "タグを保存できませんでした。");
            } finally {
              setBusy(false);
            }
          }}
        >
          <PublicTagsField value={draft} onChange={setDraft} />
          <div className={styles.actions}>
            <button type="submit" disabled={busy || !parsed.success || draft === saved}>
              {busy ? "保存中…" : "タグを保存"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(saved);
                setEditing(false);
                setError(null);
              }}
            >
              キャンセル
            </button>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
