import { validateAlias } from "@tukurium/repo-model";
import { Fragment, useEffect, useState } from "react";
import { useApp } from "../app/store";
import { api, type Work } from "../net/api";
import { useCanEdit } from "./hooks";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

const KIND_LABEL = { item: "アイテム", world: "ワールド", library: "ライブラリ" } as const;

/** 作品の名前から、別名の初めの案を作る（空白・@・/ は - にする） */
const aliasFrom = (name: string) =>
  name
    .trim()
    .replace(/[\s@/]+/g, "-")
    .slice(0, 64) || "lib";

/**
 * ライブラリ：公開されたワールドとアイテム（最新のリリース）をセッションに置く。
 * ライブラリの作品は、開いているプロジェクトの依存に足して import で使う（ADR 0015）。
 */
export function LibraryPanel() {
  const { client, session, me } = useApp();
  const placePoint = useWorkspace((s) => s.placePoint);
  const project = useWorkspace((s) => s.project);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  // 開いているプロジェクトのリポジトリ（自分のライブラリには依存できない：輪になる）
  const repoId = session?.workspaces.find((w) => w.id === workspaceId)?.repoId ?? null;
  useWorkspace((s) => s.rev);
  const canEdit = useCanEdit();
  const [works, setWorks] = useState<Work[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 依存に足そうとしている作品と、入力中の別名 */
  const [adding, setAdding] = useState<{ work: Work; alias: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const deps = project?.dependencies() ?? [];
  useEffect(() => {
    api.works().then(setWorks, (e: Error) => setError(e.message));
  }, []);
  const placed = (session?.placements ?? []).filter((p) => p.releaseId);
  const place = (w: Work) => {
    if (!w.latest) return;
    // ワールドはセッションの原点。アイテムは視線の先の床（セッションに出すときと同じ）
    const origin = { position: [0, 0, 0] as [number, number, number], yaw: 0 };
    const at = w.outputKind === "world" ? origin : (placePoint?.() ?? origin);
    client.send({
      t: "placeRelease",
      releaseId: w.latest.id,
      position: at.position,
      yaw: at.yaw,
    });
  };

  const addDependency = async () => {
    const latest = adding?.work.latest;
    if (!project || !adding || !latest) return;
    const { work, alias } = adding;
    const problem = validateAlias(alias);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 版の content hash はサーバーが計算したものを固定する（取り出せることも確かめる）
      const pkg = await api.packageVersion(work.id, latest.version);
      project.addDependency({
        alias,
        packageId: pkg.packageId,
        version: pkg.version,
        contentHash: pkg.contentHash,
      });
      setAdding(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {project && (
        <div className={ui.section}>
          <h3 className={ui.sectionTitle}>このプロジェクトで使うライブラリ</h3>
          {deps.length === 0 ? (
            <p className={ui.muted}>
              まだありません。下の一覧のライブラリを足すと、System から import できます。
            </p>
          ) : (
            <>
              <ul className={ui.list} aria-label="使うライブラリ">
                {deps.map((d) => (
                  <li key={d.alias} className={ui.item} style={{ cursor: "default" }}>
                    <span className={ui.itemName}>
                      @{d.alias}
                      <span className={ui.muted}>
                        {" "}
                        · {works.find((w) => w.id === d.packageId)?.name ?? d.packageId}
                      </span>
                    </span>
                    <span className={ui.badge}>v{d.version}</span>
                    {canEdit && (
                      <button
                        type="button"
                        className={ui.iconBtn}
                        aria-label={`@${d.alias} を外す`}
                        onClick={() => project.removeDependency(d.alias)}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <p className={ui.muted}>
                書き方：import Health from "@{deps[0]?.alias}/States/Health.koko";
                （公開の印を付けた KokoState だけ。Inspector で Entity に付けられます）
              </p>
            </>
          )}
        </div>
      )}
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>公開された作品</h3>
        <p className={ui.muted}>
          ワールドは原点に、アイテムは視線の先に置きます。置いたあとは、作っているワークスペースとは別です。
        </p>
        {error && <p className={ui.error}>{error}</p>}
        {works.length === 0 && <p className={ui.muted}>公開された作品はまだありません。</p>}
        <ul className={ui.list} aria-label="作品">
          {works.map((w) => {
            const canUse = w.perms.use || w.owner === me?.id;
            // ライブラリは置くものではなく、プロジェクトの依存に足して import で使う（ADR 0015）
            const isLibrary = w.outputKind === "library";
            const kind = w.outputKind ? KIND_LABEL[w.outputKind] : null;
            // 同じライブラリでも、別の版なら足せる（別の別名で共存する）
            const used = deps.some((d) => d.packageId === w.id && d.version === w.latest?.version);
            const own = repoId !== null && w.repoId === repoId;
            return (
              <Fragment key={w.id}>
                <li className={ui.item} style={{ cursor: "default" }}>
                  <span className={ui.itemName}>
                    {w.name}
                    <span className={ui.muted}>
                      {" "}
                      · {w.ownerName} / {w.repoName}
                    </span>
                  </span>
                  {kind && <span className={ui.badge}>{kind}</span>}
                  {w.latest ? (
                    <span className={ui.badge}>v{w.latest.version}</span>
                  ) : (
                    <span className={ui.badge}>未リリース</span>
                  )}
                  {isLibrary ? (
                    project &&
                    canEdit && (
                      <button
                        type="button"
                        className={ui.btn}
                        style={{ height: 26 }}
                        disabled={!w.latest || !canUse || used || own}
                        title={
                          used
                            ? "この版はもう使っています"
                            : own
                              ? "このプロジェクト自身のライブラリは使えません（依存が輪になります）"
                              : !canUse
                                ? "利用の権限がありません"
                                : "このプロジェクトの依存に足します（今の最新の版に固定します）"
                        }
                        onClick={() => {
                          setError(null);
                          setAdding({ work: w, alias: aliasFrom(w.name) });
                        }}
                      >
                        プロジェクトで使う
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      className={ui.btn}
                      style={{ height: 26 }}
                      disabled={!w.latest || !canUse}
                      title={
                        !canUse
                          ? "利用の権限がありません"
                          : w.outputKind === "world"
                            ? "セッションの原点に置きます"
                            : "視線の先に置きます"
                      }
                      onClick={() => place(w)}
                    >
                      セッションに置く
                    </button>
                  )}
                </li>
                {adding?.work.id === w.id && (
                  <li>
                    <form
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 8px" }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void addDependency();
                      }}
                    >
                      <span className={ui.muted}>@</span>
                      <input
                        className={ui.input}
                        aria-label="別名"
                        value={adding.alias}
                        // biome-ignore lint/a11y/noAutofocus: 押した直後に別名を入れるため
                        autoFocus
                        onChange={(e) => setAdding({ work: w, alias: e.target.value })}
                      />
                      <button type="submit" className={ui.btn} disabled={busy}>
                        足す
                      </button>
                      <button type="button" className={ui.btn} onClick={() => setAdding(null)}>
                        やめる
                      </button>
                    </form>
                  </li>
                )}
              </Fragment>
            );
          })}
        </ul>
      </div>
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>置いた作品</h3>
        {placed.length === 0 ? (
          <p className={ui.muted}>まだありません</p>
        ) : (
          <ul className={ui.list} aria-label="置いた作品">
            {placed.map((p) => (
              <li key={p.id} className={ui.item} style={{ cursor: "default" }}>
                <span className={ui.itemName}>{p.workspaceName}</span>
                <button
                  type="button"
                  className={ui.btn}
                  style={{ height: 26 }}
                  onClick={() => client.send({ t: "resetPart", placementId: p.id })}
                >
                  リセット
                </button>
                <button
                  type="button"
                  className={ui.iconBtn}
                  aria-label={`${p.workspaceName} を外す`}
                  onClick={() => client.send({ t: "unplace", placementId: p.id })}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
