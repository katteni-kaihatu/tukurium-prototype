import type { UserInfo } from "@tukurium/shared";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Header } from "../app/Header";
import { useApp } from "../app/store";
import { api, type CommitInfo, type RepoMeta, type Work } from "../net/api";
import { ProjectHome } from "./ProjectHome";
import home from "./ProjectHome.module.css";
import styles from "./pages.module.css";
import {
  activityFromCommits,
  type ListedProject,
  type ListedRelease,
  type ProjectActivity,
} from "./projectHomeModel";

/** プロフィール。プロジェクトウィンドウでは、一覧のホームとして開く。 */
export function ProfilePage({
  embedded = false,
  profileId,
}: {
  embedded?: boolean;
  profileId?: string;
}) {
  const params = useParams();
  const userId = profileId ?? params.userId ?? "";
  const me = useApp((s) => s.me);
  const id = userId === "me" ? me?.id : userId;
  const [user, setUser] = useState<
    | (UserInfo & {
        repos: RepoMeta[];
        works: Work[];
      })
    | null
  >(null);
  const [works, setWorks] = useState<Work[] | null>(null);
  const [activity, setActivity] = useState<Record<string, ProjectActivity>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setUser(null);
    setWorks(null);
    setActivity({});
    setError(null);
    if (id && me) {
      void api.user(id).then(
        (value) => {
          if (active) setUser(value);
        },
        (e: Error) => {
          if (active) setError(e.message);
        },
      );
      // 版の番号は、ユーザーの作品一覧のほうに付いている
      void api.works(id).then(
        (value) => {
          if (active) setWorks(value);
        },
        () => undefined,
      );
    }
    return () => {
      active = false;
    };
  }, [id, me]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    const now = Date.now();
    void Promise.all(
      user.repos.map(async (repo) => {
        const commits = await api.commits(repo.id).catch(() => [] as CommitInfo[]);
        const times = commits.map((commit) => commit.author.timestamp * 1000);
        return [repo.id, activityFromCommits(times, repo.createdAt, now)] as const;
      }),
    ).then((rows) => {
      if (active) setActivity(Object.fromEntries(rows));
    });
    return () => {
      active = false;
    };
  }, [user]);

  const shownWorks = works ?? user?.works ?? [];
  const repos = (user?.repos ?? []).map((repo) => toProject(repo, activity[repo.id]?.savedAt));
  const releases = shownWorks.map((work) => toRelease(work, user?.repos ?? []));

  return (
    <div className={embedded ? home.frame : styles.page}>
      {!embedded && <Header />}
      <div className={embedded ? undefined : styles.main}>
        {error && <p className={styles.error}>{error}</p>}
        {!user && !error && <p className={home.loading}>読み込んでいます…</p>}
        {user && (
          <ProjectHome
            embedded={embedded}
            name={user.name}
            account={user.account}
            avatarUrl={user.avatarUrl}
            self={user.id === me?.id}
            repos={repos}
            releases={releases}
            activity={activity}
          />
        )}
      </div>
    </div>
  );
}

function toProject(repo: RepoMeta, savedAt: number | undefined): ListedProject {
  const created = Date.parse(repo.createdAt);
  return {
    id: repo.id,
    name: repo.name,
    description: repo.description,
    kind: repo.kind,
    visibility: repo.visibility,
    createdAt: repo.createdAt,
    updatedAt: savedAt ?? (Number.isFinite(created) ? created : 0),
    forkedFrom: repo.forkedFrom
      ? { repoId: repo.forkedFrom.repoId, repoName: repo.forkedFrom.repoName }
      : null,
  };
}

function toRelease(work: Work, repos: RepoMeta[]): ListedRelease {
  const repo = repos.find((item) => item.id === work.repoId);
  const at = Date.parse(work.latest?.createdAt ?? work.createdAt);
  return {
    id: work.id,
    name: work.name,
    repoId: work.repoId,
    repoName: work.repoName ?? repo?.name ?? "",
    kind: work.outputKind ?? repo?.kind ?? "item",
    version: work.latest?.version ?? null,
    at: Number.isFinite(at) ? at : 0,
  };
}
