import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { api, type Work } from "../net/api";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

const KIND_LABEL = { item: "アイテム", world: "ワールド", library: "ライブラリ" } as const;

/** ライブラリ：公開されたワールドとアイテム（最新のリリース）をセッションに置く */
export function LibraryPanel() {
  const { client, session, me } = useApp();
  const placePoint = useWorkspace((s) => s.placePoint);
  const [works, setWorks] = useState<Work[]>([]);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <>
      <div className={ui.section}>
        <h3 className={ui.sectionTitle}>公開されたワールドとアイテム</h3>
        <p className={ui.muted}>
          ワールドは原点に、アイテムは視線の先に置きます。置いたあとは、作っているワークスペースとは別です。
        </p>
        {error && <p className={ui.error}>{error}</p>}
        {works.length === 0 && <p className={ui.muted}>公開された作品はまだありません。</p>}
        <ul className={ui.list} aria-label="作品">
          {works.map((w) => {
            const canUse = w.perms.use || w.owner === me?.id;
            const kind = w.outputKind ? KIND_LABEL[w.outputKind] : null;
            return (
              <li key={w.id} className={ui.item} style={{ cursor: "default" }}>
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
              </li>
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
