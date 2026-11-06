import { ImagePreview, ModelPreview } from "./AssetPreview";
import { type DiffEntry, type DiffLine, diffKindLabel } from "./diffView";
import styles from "./history.module.css";
import ui from "./ui.module.css";

/**
 * 名前で並べた差分。行を押すと、パネルの右側の欄に階層や欄、コード、見た目を出す。
 * revertable を渡すと、戻せる行にマウスを載せたとき、元に戻すボタンを出す。
 */
export function ChangeList({
  entries,
  selected,
  onSelect,
  revertable,
  onRevert,
}: {
  entries: DiffEntry[];
  selected: string | null;
  onSelect: (id: string) => void;
  revertable?: (entry: DiffEntry) => boolean;
  onRevert?: (entry: DiffEntry) => void;
}) {
  if (entries.length === 0) return <p className={styles.emptyDiff}>差分はありません</p>;
  const groups = new Map<string, DiffEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.group) ?? [];
    list.push(entry);
    groups.set(entry.group, list);
  }
  return (
    <div className={styles.groups}>
      {[...groups.values()].map((list) => (
        <section key={list[0]?.group} aria-label={list[0]?.groupLabel}>
          <h5 className={styles.groupTitle}>
            {list[0]?.groupLabel}
            <span className={styles.groupCount}>{list.length}</span>
          </h5>
          <ul className={styles.tree}>
            {list.map((entry) => (
              <li key={entry.id} className={styles.changeRow}>
                <button
                  type="button"
                  className={styles.change}
                  aria-pressed={selected === entry.id}
                  data-change={entry.kind}
                  onClick={() => onSelect(entry.id)}
                >
                  <span className={styles.changeName}>{entry.name}</span>
                  {entry.hint && <span className={styles.changeHint}>{entry.hint}</span>}
                  <span className={styles.kind}>{diffKindLabel(entry.kind)}</span>
                </button>
                {onRevert && revertable?.(entry) && (
                  <button
                    type="button"
                    className={`${ui.iconBtn} ${styles.revertBtn}`}
                    aria-label={`${entry.name} を元に戻す`}
                    title="最後に保存した形に戻す"
                    onClick={() => onRevert(entry)}
                  >
                    <RevertIcon />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** パネルの右側の欄。選んだ差分ひとつの中身を出す */
export function ChangeSide({ entry }: { entry: DiffEntry | null }) {
  if (!entry) {
    return (
      <aside className={styles.side} aria-label="差分の詳細">
        <p className={styles.sideEmpty}>差分を選ぶと、ここに中身が出ます</p>
      </aside>
    );
  }
  const empty = entry.lines.length === 0 && !entry.code?.length && !entry.preview;
  return (
    <aside className={styles.side} aria-label="差分の詳細">
      <div className={styles.sideHead}>
        <span className={styles.sideGroup}>{entry.groupLabel}</span>
        <h4 className={styles.sideName} data-change={entry.kind}>
          {entry.name}
        </h4>
        <span className={styles.kind}>{diffKindLabel(entry.kind)}</span>
      </div>
      {entry.hint && <p className={ui.muted}>{entry.hint}</p>}
      {empty ? (
        <p className={styles.emptyDiff}>くわしい中身はありません</p>
      ) : (
        <ChangeDetail entry={entry} />
      )}
    </aside>
  );
}

/** 元に戻す（左回りの矢印） */
export function RevertIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M4.2 6.2H10a3.3 3.3 0 0 1 0 6.6H6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M6.6 3.6 4 6.2l2.6 2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 差分ひとつの中身（欄の前後、コードの行、見た目） */
export function ChangeDetail({ entry }: { entry: DiffEntry }) {
  return (
    <div className={styles.changeDetail}>
      {entry.lines.length > 0 && (
        <ul className={styles.lines}>
          {withKeys(
            entry.lines,
            (line) => `${line.label}\0${line.before ?? ""}\0${line.after ?? ""}`,
          ).map(({ item: line, key }) => (
            <li key={key}>
              <span className={styles.lineLabel}>{line.label}</span>
              <LineValue line={line} />
            </li>
          ))}
        </ul>
      )}
      {entry.code && entry.code.length > 0 && (
        <pre className={styles.code}>
          {withKeys(entry.code, (row) => `${row.kind}:${row.text}`).map(({ item: row, key }) => (
            <div key={key} data-kind={row.kind}>
              {row.kind === "add"
                ? "+ "
                : row.kind === "del"
                  ? "− "
                  : row.kind === "gap"
                    ? ""
                    : "  "}
              {row.text}
            </div>
          ))}
        </pre>
      )}
      {entry.preview && <PreviewPair entry={entry} />}
    </div>
  );
}

function withKeys<T>(items: T[], baseOf: (item: T) => string): { item: T; key: string }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = baseOf(item);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { item, key: `${base}#${n}` };
  });
}

function LineValue({ line }: { line: DiffLine }) {
  if (line.before === line.after) return <Value text={line.before ?? "（なし）"} />;
  return (
    <span className={styles.lineValues}>
      <Value text={line.before ?? "（なし）"} tone={line.before === null ? undefined : "del"} />
      <span className={styles.arrow}>→</span>
      <Value text={line.after ?? "（なし）"} tone={line.after === null ? undefined : "add"} />
    </span>
  );
}

function Value({ text, tone }: { text: string; tone?: "add" | "del" }) {
  const color = /^#[0-9a-fA-F]{3,8}$/.test(text);
  return (
    <span className={tone === "add" ? styles.addText : tone === "del" ? styles.delText : undefined}>
      {color && <span className={styles.swatch} style={{ background: text }} />}
      {text}
    </span>
  );
}

function PreviewPair({ entry }: { entry: DiffEntry }) {
  const preview = entry.preview;
  if (!preview) return null;
  return (
    <div className={styles.pair}>
      <figure className={styles.preview}>
        <figcaption>変更前</figcaption>
        {preview.beforeId ? (
          <Thumb kind={preview.kind} id={preview.beforeId} name={entry.name} />
        ) : (
          <p className={styles.previewEmpty}>なし</p>
        )}
      </figure>
      <figure className={styles.preview}>
        <figcaption>変更後</figcaption>
        {preview.afterId ? (
          <Thumb kind={preview.kind} id={preview.afterId} name={entry.name} />
        ) : (
          <p className={styles.previewEmpty}>なし</p>
        )}
      </figure>
    </div>
  );
}

function Thumb({ kind, id, name }: { kind: "model" | "image"; id: string; name: string }) {
  if (kind === "image") return <ImagePreview id={id} name={name} />;
  return <ModelPreview id={id} />;
}
