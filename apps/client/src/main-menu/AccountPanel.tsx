import { useEffect, useId, useState } from "react";
import { AvatarFace } from "../app/AvatarFace";
import { useApp } from "../app/store";
import { logout } from "../auth/auth";
import styles from "./AccountPanel.module.css";

const NAME_LIMIT = 32;

/**
 * アカウント（ADR 0074）。ログインしたアカウントとアイコンを見せ、表示名を変え、ログアウトする。
 * 表示名を変えても、ログインに使ったアカウントや、人に結び付くもの（プロジェクト・フレンドなど）はそのまま
 */
export function AccountPanel() {
  const me = useApp((s) => s.me);
  const setName = useApp((s) => s.setName);
  const connected = useApp((s) => s.status === "online");
  const [draft, setDraft] = useState(me?.name ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  useEffect(() => setDraft(me?.name ?? ""), [me?.name]);
  const trimmed = draft.trim();
  const changed = trimmed !== "" && trimmed !== me?.name;

  return (
    <div className={styles.panel}>
      <section className={styles.who} aria-label="ログインしているアカウント">
        <span className={styles.avatar} aria-hidden="true">
          <AvatarFace user={me} />
        </span>
        <div>
          <strong>{me?.name}</strong>
          {me?.account && <span className={styles.account}>{me.account}</span>}
        </div>
      </section>
      <form
        className={styles.rename}
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed || !connected) return;
          setName(trimmed);
          setSaved(true);
        }}
      >
        <label htmlFor={nameId}>表示名</label>
        <div className={styles.row}>
          <input
            id={nameId}
            value={draft}
            maxLength={NAME_LIMIT}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
          />
          <button type="submit" className={styles.submit} disabled={!changed || !connected}>
            変える
          </button>
        </div>
        <p className={styles.hint} role="status">
          {saved
            ? "表示名を変えました。"
            : "セッションやフレンドに見える名前です。最初は Misskey の名前になっています。"}
        </p>
      </form>
      <footer className={styles.actions}>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            logout().catch((e: Error) => {
              setError(e.message);
              setBusy(false);
            });
          }}
        >
          {busy ? "ログアウトしています…" : "ログアウト"}
        </button>
      </footer>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
