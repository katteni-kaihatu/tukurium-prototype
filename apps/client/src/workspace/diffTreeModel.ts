import type { FileChange } from "@tukurium/repo-model";

/** 差分の木の 1 節。change があるのはファイル、children があるのはフォルダ。 */
export interface DiffNode {
  name: string;
  path: string;
  change: FileChange | null;
  children: DiffNode[];
}

/** ファイルパスの差分を、フォルダの木にまとめる。フォルダが先、名前順。 */
export function buildDiffTree(changes: FileChange[]): DiffNode[] {
  const root: DiffNode = { name: "", path: "", change: null, children: [] };
  for (const change of changes) {
    const parts = change.path.split("/").filter((p) => p.length > 0);
    let cur = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i] ?? "";
      acc = acc ? `${acc}/${name}` : name;
      const last = i === parts.length - 1;
      let child = cur.children.find((c) => c.name === name);
      if (!child) {
        child = { name, path: acc, change: last ? change : null, children: [] };
        cur.children.push(child);
      } else if (last) {
        child.change = change;
      }
      cur = child;
    }
  }
  const sort = (node: DiffNode) => {
    node.children.sort((a, b) => {
      const aDir = a.children.length > 0;
      const bDir = b.children.length > 0;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name, "ja");
    });
    for (const child of node.children) sort(child);
  };
  sort(root);
  return root.children;
}
