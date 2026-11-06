import fs from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FileMap } from "@tukurium/repo-model";
import git from "isomorphic-git";

export interface CommitInfo {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
  parents: string[];
}

export interface Author {
  id: string;
  name: string;
}

const email = (a: Author) => `${a.id}@users.tukurium`;
const BRANCH = "refs/heads/main";

/**
 * リポジトリの履歴を Git に保存する（ADR 0007）。作業ツリーは持たず、bare リポジトリに
 * blob・tree・commit を直接書く。ブランチは main だけ（1 リポジトリ 1 ワークスペース）。
 */
export class GitStore {
  constructor(private readonly root: string) {}

  private gitdir(repoId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(repoId)) throw new Error(`invalid repo id: ${repoId}`);
    return join(this.root, `${repoId}.git`);
  }

  async init(repoId: string): Promise<void> {
    const gitdir = this.gitdir(repoId);
    await mkdir(gitdir, { recursive: true });
    await git.init({ fs, dir: gitdir, gitdir, bare: true, defaultBranch: "main" });
  }

  async head(repoId: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs, gitdir: this.gitdir(repoId), ref: BRANCH });
    } catch {
      return null;
    }
  }

  /** ファイルの集まりをそのままコミットにする（前のコミットとの差分は Git が持つ） */
  async commit(
    repoId: string,
    files: FileMap,
    message: string,
    author: Author,
    coAuthors: Author[] = [],
  ): Promise<string> {
    const gitdir = this.gitdir(repoId);
    const tree = await this.writeTree(gitdir, files);
    const parent = await this.head(repoId);
    const now = Math.floor(Date.now() / 1000);
    const person = { name: author.name, email: email(author), timestamp: now, timezoneOffset: 0 };
    const trailers = coAuthors.map((c) => `Co-authored-by: ${c.name} <${email(c)}>`).join("\n");
    const oid = await git.writeCommit({
      fs,
      gitdir,
      commit: {
        tree,
        parent: parent ? [parent] : [],
        author: person,
        committer: person,
        message: `${message.trim()}\n${trailers ? `\n${trailers}\n` : ""}`,
      },
    });
    await git.writeRef({ fs, gitdir, ref: BRANCH, value: oid, force: true });
    return oid;
  }

  /** リリースに添えるコメント。保存したときのメッセージから、共同制作者の行を除く。 */
  async message(repoId: string, oid: string): Promise<string> {
    try {
      const { commit } = await git.readCommit({ fs, gitdir: this.gitdir(repoId), oid });
      return commit.message
        .split("\n")
        .filter((line) => !line.startsWith("Co-authored-by:"))
        .join("\n")
        .trim();
    } catch {
      return "";
    }
  }

  async log(repoId: string, depth = 100): Promise<CommitInfo[]> {
    if (!(await this.head(repoId))) return [];
    const entries = await git.log({ fs, gitdir: this.gitdir(repoId), ref: BRANCH, depth });
    return entries.map((e) => ({
      oid: e.oid,
      message: e.commit.message.trim(),
      author: {
        name: e.commit.author.name,
        email: e.commit.author.email,
        timestamp: e.commit.author.timestamp,
      },
      parents: e.commit.parent,
    }));
  }

  /** コミット（省略時は最新）のファイルを読む */
  async files(repoId: string, commit?: string): Promise<FileMap> {
    const gitdir = this.gitdir(repoId);
    const oid = commit ?? (await this.head(repoId));
    if (!oid) return {};
    const { commit: c } = await git.readCommit({ fs, gitdir, oid });
    const out: FileMap = {};
    const walk = async (treeOid: string, prefix: string) => {
      const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
      for (const entry of tree) {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === "tree") await walk(entry.oid, path);
        else {
          const { blob } = await git.readBlob({ fs, gitdir, oid: entry.oid });
          out[path] = new TextDecoder().decode(blob);
        }
      }
    };
    await walk(c.tree, "");
    return out;
  }

  /** フォーク：履歴ごと複製する */
  async fork(fromRepo: string, toRepo: string): Promise<void> {
    await cp(this.gitdir(fromRepo), this.gitdir(toRepo), { recursive: true });
  }

  async remove(repoId: string): Promise<void> {
    await rm(this.gitdir(repoId), { recursive: true, force: true });
  }

  private async writeTree(gitdir: string, files: FileMap): Promise<string> {
    // パスを階層に分けて、下の階層から tree を作る
    type Dir = { files: Map<string, string>; dirs: Map<string, Dir> };
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split("/");
      const name = parts.pop() as string;
      let d = root;
      for (const p of parts) {
        let next = d.dirs.get(p);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          d.dirs.set(p, next);
        }
        d = next;
      }
      d.files.set(name, content);
    }
    const write = async (d: Dir): Promise<string> => {
      const entries: { mode: string; path: string; oid: string; type: "blob" | "tree" }[] = [];
      for (const [name, content] of d.files) {
        const oid = await git.writeBlob({ fs, gitdir, blob: new TextEncoder().encode(content) });
        entries.push({ mode: "100644", path: name, oid, type: "blob" });
      }
      for (const [name, sub] of d.dirs)
        entries.push({ mode: "040000", path: name, oid: await write(sub), type: "tree" });
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return git.writeTree({ fs, gitdir, tree: entries });
    };
    return write(root);
  }
}
