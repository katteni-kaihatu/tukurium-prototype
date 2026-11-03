import type { FileChange } from "@tukurium/repo-model";
import { useMemo, useState } from "react";
import { buildDiffTree, type DiffNode } from "./diffTree";
import styles from "./history.module.css";

const CHANGE_LABEL = { added: "新しい", removed: "消えた", modified: "変わった" } as const;

/** 差分をフォルダの木で出す。最初は開いた状態。 */
export function DiffTree({ changes }: { changes: FileChange[] }) {
  const tree = useMemo(() => buildDiffTree(changes), [changes]);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  if (changes.length === 0) return <p className={styles.emptyDiff}>差分はありません</p>;

  const toggle = (path: string) => setClosed((prev) => ({ ...prev, [path]: !prev[path] }));

  return (
    <ul className={styles.tree}>
      {tree.map((node) => (
        <DiffBranch key={node.path} node={node} depth={0} closed={closed} toggle={toggle} />
      ))}
    </ul>
  );
}

function DiffBranch({
  node,
  depth,
  closed,
  toggle,
}: {
  node: DiffNode;
  depth: number;
  closed: Record<string, boolean>;
  toggle: (path: string) => void;
}) {
  const isFolder = node.children.length > 0;
  if (!isFolder && node.change) {
    return <DiffFile node={node} depth={depth} />;
  }
  const open = !closed[node.path];
  return (
    <li>
      <button
        type="button"
        className={styles.folder}
        style={{ paddingLeft: 6 + depth * 14 }}
        aria-expanded={open}
        onClick={() => toggle(node.path)}
      >
        <Chevron open={open} />
        <span className={styles.folderName}>{node.name}</span>
      </button>
      {open && (
        <ul className={styles.tree}>
          {node.children.map((child) => (
            <DiffBranch
              key={child.path}
              node={child}
              depth={depth + 1}
              closed={closed}
              toggle={toggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function DiffFile({ node, depth }: { node: DiffNode; depth: number }) {
  const change = node.change;
  if (!change) return null;
  return (
    <li
      className={styles.file}
      style={{ paddingLeft: 22 + depth * 14 }}
      data-change={change.change}
    >
      <span className={styles.fileName}>{node.name}</span>
      <span className={styles.kind}>{CHANGE_LABEL[change.change]}</span>
      <span className={styles.add}>+{change.add}</span>
      <span className={styles.del}>−{change.del}</span>
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      className={styles.chev}
      style={{ transform: open ? undefined : "rotate(-90deg)" }}
    >
      <path
        d="M4 6l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
