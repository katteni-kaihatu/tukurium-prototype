import type { FileMap } from "@tukurium/repo-model";
import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { api } from "../net/api";
import { useWorkspace } from "./store";

const cache = new Map<string, FileMap>();
const pending = new Map<string, Promise<FileMap>>();

function load(key: string, repoId: string): Promise<FileMap> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const running = pending.get(key);
  if (running) return running;
  const next = api
    .files(repoId)
    .then((files) => {
      cache.set(key, files);
      return files;
    })
    .finally(() => pending.delete(key));
  pending.set(key, next);
  return next;
}

/**
 * 最後に保存したファイル。保存のたびに読み直す。
 * 読めないあいだは null（画面は印を出さない）。
 */
export function useSavedFiles(): FileMap | null {
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const commitRev = useWorkspace((s) => s.commitRev);
  const session = useApp((s) => s.session);
  const repoId = session?.workspaces.find((w) => w.id === workspaceId)?.repoId ?? null;
  const [state, setState] = useState<{ repoId: string; files: FileMap } | null>(null);

  useEffect(() => {
    if (!repoId) return;
    let alive = true;
    load(`${repoId}:${commitRev}`, repoId).then(
      (files) => {
        if (alive) setState({ repoId, files });
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [repoId, commitRev]);

  return state && state.repoId === repoId ? state.files : null;
}
