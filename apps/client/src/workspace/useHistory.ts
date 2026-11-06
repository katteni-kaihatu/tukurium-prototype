import { fromFiles } from "@tukurium/repo-model";
import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { api, type CommitInfo } from "../net/api";
import { type DiffEntry, describeDiff } from "./diffView";
import { useProject } from "./hooks";
import { useWorkspace } from "./store";

/** 履歴と保存パネルが共有する、コミット一覧と未保存の差分。 */
export function useHistory() {
  const project = useProject();
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const commitRev = useWorkspace((s) => s.commitRev);
  const rev = useWorkspace((s) => s.rev);
  const client = useApp((s) => s.client);
  const session = useApp((s) => s.session);
  const me = useApp((s) => s.me);
  const repoId = session?.workspaces.find((w) => w.id === workspaceId)?.repoId ?? null;

  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [headFiles, setHeadFiles] = useState<Record<string, string> | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [entries, setEntries] = useState<DiffEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // commitRev は保存のたびに増える。効果の中では参照せず、読み直すきっかけにだけ使う
  // biome-ignore lint/correctness/useExhaustiveDependencies: commitRev は読み直すきっかけ
  useEffect(() => {
    if (!repoId) return;
    let alive = true;
    api.commits(repoId).then(
      (list) => {
        if (alive) setCommits(list);
      },
      (e: Error) => {
        if (alive) setError(e.message);
      },
    );
    api.files(repoId).then(
      (files) => {
        if (alive) setHeadFiles(files);
      },
      () => {
        if (alive) setHeadFiles({});
      },
    );
    api.repo(repoId).then(
      (repo) => {
        if (alive) setOwner(repo.owner);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [repoId, commitRev]);

  // 未保存の差分（最新の保存との差）。rev は中身が変わった合図で、効果の中では参照しない
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev は計算し直すきっかけ
  useEffect(() => {
    if (!headFiles) return;
    const timer = setTimeout(
      () =>
        setEntries(
          describeDiff(fromFiles(headFiles), { ...project.snapshot(), name: project.name }),
        ),
      300,
    );
    return () => clearTimeout(timer);
  }, [headFiles, project, rev]);

  const others = (session?.workspaces.find((w) => w.id === workspaceId)?.present ?? []).filter(
    (id) => id !== me?.id,
  );
  const names = others.map((id) => session?.participants.find((p) => p.id === id)?.name ?? id);

  const save = (message: string) => {
    if (!workspaceId) return;
    client.send({ t: "ws.commit", workspaceId, message });
  };

  return {
    repoId,
    commits,
    entries,
    error,
    ready: headFiles !== null,
    isOwner: owner !== null && owner === me?.id,
    names,
    commitRev,
    save,
  };
}
