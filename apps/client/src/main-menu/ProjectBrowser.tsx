import { useApp } from "../app/store";
import { ExplorePage } from "../pages/ExplorePage";
import { NewRepoPage } from "../pages/NewRepoPage";
import { ProfilePage } from "../pages/ProfilePage";
import { ProjectNavigation } from "../pages/ProjectNavigation";
import { ProjectPage } from "../pages/ProjectPage";
import { WorkspaceStart } from "../workspace/WorkspacePanels";
import styles from "./MainMenu.module.css";
import { useMainMenu } from "./store";

/** プロジェクトの閲覧はメニュー内の移動。SessionView と 3D 空間を保つ。 */
export function ProjectBrowser({ path }: { path: string }) {
  const { editingPending, editingError } = useMainMenu();
  const session = useApp((s) => s.session);
  const [kind, id] = path.slice(1).split("/");
  return (
    <ProjectNavigation.Provider
      value={(to) => {
        if (typeof to === "number") useMainMenu.getState().backProject();
        else useMainMenu.getState().showProject(to);
      }}
    >
      {kind !== "workspaces" && kind !== "u" && (
        <div className={`${styles.toolbar} ${styles.projectToolbar}`}>
          <button
            type="button"
            className={styles.button}
            onClick={() => useMainMenu.getState().backProject()}
          >
            ← 戻る
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => useMainMenu.getState().showProject("/u/me")}
          >
            自分のプロジェクト
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => useMainMenu.getState().showProject("/explore")}
          >
            リリース・プロジェクトを探す
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => useMainMenu.getState().showProject("/new")}
          >
            新しいプロジェクト
          </button>
        </div>
      )}
      {kind === "workspaces" ? (
        <section aria-label="制作を始める">
          <div className={styles.pageHeader}>
            <div>
              <h1>制作を始める</h1>
              <p className={styles.muted}>編集するプロジェクトをワークスペースで開きます。</p>
            </div>
          </div>
          {editingError && (
            <p role="alert" className={styles.error}>
              {editingError}
            </p>
          )}
          {editingPending && <p role="status">ワークスペースを開いています…</p>}
          {session ? (
            <WorkspaceStart />
          ) : (
            <>
              <p>制作する場所を先に選んでください。</p>
              <button
                type="button"
                className={styles.primary}
                onClick={() => {
                  useMainMenu.getState().show("sessions");
                  useMainMenu.setState({ editAfterJoin: "chooser", returnAfterJoin: null });
                }}
              >
                セッションを選ぶ
              </button>
            </>
          )}
        </section>
      ) : kind === "p" && id ? (
        <ProjectPage key={path} embedded projectId={id} />
      ) : kind === "u" && id ? (
        <ProfilePage key={path} embedded profileId={id} />
      ) : kind === "new" ? (
        <NewRepoPage embedded />
      ) : (
        <ExplorePage embedded />
      )}
    </ProjectNavigation.Provider>
  );
}
