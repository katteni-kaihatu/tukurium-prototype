import type { SocialProfile } from "@tukurium/shared";
import { useEffect, useId, useRef, useState } from "react";
import { AvatarFace } from "../app/AvatarFace";
import { useApp } from "../app/store";
import { api } from "../net/api";
import styles from "./StatusPanel.module.css";
import { AVAILABILITY, changeSocial, useSocial } from "./socialStore";
import { useMainMenu } from "./store";

type Availability = SocialProfile["availability"];

const DESCRIPTIONS: Record<Availability, string> = {
  joinable: "フレンドに、参加や招待を歓迎していると伝えます。",
  online: "いつもの状態。いるセッションがフレンドに見えます。",
  ask: "参加する前に、ひと声かけてほしいと伝えます。",
  busy: "いまは取り込み中だとフレンドに伝えます。",
};
const NOTE_LIMIT = 32;

export function StatusBadge({
  availability,
  online = true,
}: {
  availability: Availability;
  online?: boolean;
}) {
  return (
    <span className={styles.badge} data-status={online ? availability : "offline"}>
      <span className={styles.dot} aria-hidden="true" />
      {online ? AVAILABILITY[availability] : "オフライン"}
    </span>
  );
}

export function StatusPanel({ active }: { active: boolean }) {
  const profile = useSocial((s) => s.data?.profile);
  // 共通ウィンドウの位置は残し、閉じたときだけ未保存の入力を捨てる。
  return active && profile ? <StatusEditor profile={profile} /> : null;
}

function StatusEditor({ profile }: { profile: SocialProfile }) {
  const [draft, setDraft] = useState(profile);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { busy, error } = useSocial();
  const me = useApp((s) => s.me);
  const connected = useApp((s) => s.status === "online");
  const noteId = useId();
  const countId = useId();
  const radioName = useId();
  const tooLong = draft.note.length > NOTE_LIMIT;
  const close = () => {
    useMainMenu.getState().close("status");
    document.querySelector<HTMLButtonElement>('[data-window-button="status"]')?.focus();
  };

  return (
    <form
      className={styles.form}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !connected || tooLong) return;
        const saved = await changeSocial(() => api.updateSocial(draft));
        // 保存中に閉じて開き直した場合、新しい入力中の窓は閉じない。
        if (saved && mounted.current) close();
      }}
    >
      <p className={styles.audience}>フレンドに見える</p>
      <fieldset className={styles.options}>
        <legend>いまの状態</legend>
        {(Object.keys(AVAILABILITY) as Availability[]).map((value) => (
          <label className={styles.option} data-status={value} key={value}>
            <input
              type="radio"
              name={radioName}
              value={value}
              checked={draft.availability === value}
              onChange={() => setDraft({ ...draft, availability: value })}
            />
            <span className={styles.dot} aria-hidden="true" />
            <span>
              <strong>{AVAILABILITY[value]}</strong>
              <span className={styles.description}>{DESCRIPTIONS[value]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className={styles.note}>
        <div className={styles.noteHeading}>
          <label htmlFor={noteId}>ひとこと</label>
          <span id={countId}>
            {draft.note.length} / {NOTE_LIMIT}
          </span>
        </div>
        <input
          id={noteId}
          aria-describedby={countId}
          aria-invalid={tooLong || undefined}
          placeholder="いま何をしているか"
          maxLength={NOTE_LIMIT}
          value={draft.note}
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        />
        {tooLong && <p role="alert">ひとことは32文字以内にしてください。</p>}
      </div>
      <section className={styles.preview} aria-label="フレンドからの見え方">
        <p>フレンドからはこう見える</p>
        <div className={styles.person}>
          <span className={styles.avatar} data-status={draft.availability} aria-hidden="true">
            <AvatarFace user={me} />
            <span className={styles.dot} />
          </span>
          <div>
            <strong>{me?.name}</strong>
            <StatusBadge availability={draft.availability} />
            {draft.note.trim() && <span className={styles.previewNote}>{draft.note.trim()}</span>}
          </div>
        </div>
      </section>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!connected && (
        <p className={styles.error} role="status">
          接続が戻ると設定できます。
        </p>
      )}
      <footer className={styles.actions}>
        <button type="button" onClick={close}>
          キャンセル
        </button>
        <button className={styles.submit} type="submit" disabled={busy || !connected || tooLong}>
          {busy ? "設定中…" : "設定する"}
        </button>
      </footer>
    </form>
  );
}
