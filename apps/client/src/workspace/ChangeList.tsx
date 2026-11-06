import { Fragment } from "react";
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

/**
 * 行ごとに戻す操作。part は DiffLine の part（"name" や "field:<KokoState>:<欄>" など）。
 * revertable が false の行には、ボタンを出さない。
 */
export interface PartRevert {
  revertable: (part: string) => boolean;
  onRevert: (part: string) => void;
}

/** パネルの右側の欄。選んだ差分ひとつの中身を出す。revert を渡すと、行ごとに戻すボタンを出す */
export function ChangeSide({
  entry,
  revert,
  error,
}: {
  entry: DiffEntry | null;
  revert?: PartRevert;
  error?: string | null;
}) {
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
        <ChangeDetail entry={entry} revert={revert} />
      )}
      {error && <p className={ui.error}>{error}</p>}
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

/** 差分ひとつの中身（欄の前後、コードの行、見た目）。revert を渡すと、行ごとに戻すボタンを出す */
const SECTION_LABEL = { added: "付けた", removed: "外した", modified: "変えた" } as const;

export function ChangeDetail({ entry, revert }: { entry: DiffEntry; revert?: PartRevert }) {
  const can = (part: string | undefined): part is string =>
    part !== undefined && revert?.revertable(part) === true;
  return (
    <div className={styles.changeDetail}>
      {entry.lines.length > 0 && (
        <ul className={styles.lines} data-revert={revert ? "" : undefined}>
          {withKeys(
            entry.lines,
            (line) =>
              `${line.section?.key ?? ""}\0${line.label}\0${line.before ?? ""}\0${line.after ?? ""}`,
          ).map(({ item: line, key }, i) => {
            // KokoState ごとにまとめる：同じ見出しの最初の行の前に、見出しを一つだけ出す
            const section = line.section;
            const first = section && entry.lines[i - 1]?.section?.key !== section.key;
            return (
              <Fragment key={key}>
                {section && first && (
                  <li className={styles.sectionHead} data-change={section.change}>
                    <span className={styles.sectionName}>{section.label}</span>
                    <span className={styles.kind}>{SECTION_LABEL[section.change]}</span>
                    {revert &&
                      (can(section.key) ? (
                        <PartButton
                          label={`${section.label} を元に戻す`}
                          onClick={() => revert.onRevert(section.key)}
                        />
                      ) : (
                        <span />
                      ))}
                  </li>
                )}
                <li data-in-section={section ? "" : undefined}>
                  <span className={styles.lineLabel}>{line.label}</span>
                  <LineValue line={line} />
                  {revert &&
                    (can(line.part) && line.part !== section?.key ? (
                      <PartButton
                        label={`${section ? `${section.label} / ` : ""}${line.label} を元に戻す`}
                        onClick={() => line.part && revert.onRevert(line.part)}
                      />
                    ) : (
                      <span />
                    ))}
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
      {entry.code && entry.code.length > 0 && revert && can("code") && (
        <div className={styles.codeHead}>
          <span className={styles.lineLabel}>コード</span>
          <PartButton label="コードを元に戻す" onClick={() => revert.onRevert("code")} />
        </div>
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

function PartButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`${ui.iconBtn} ${styles.partRevert}`}
      aria-label={label}
      title="最後に保存した形に戻す"
      onClick={onClick}
    >
      <RevertIcon />
    </button>
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
