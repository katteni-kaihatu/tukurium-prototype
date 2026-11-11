import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { api, type Work } from "../net/api";
import ui from "../workspace/ui.module.css";
import { currentWorld } from "./openWorld";

/**
 * セッションで開くワールドを選ぶ（利用者向け）。
 * 公開されているワールドから一つ選ぶ。開くと、3秒後にいまのワールドは入れ替わる。
 */
export function SessionBelongings() {
  const client = useApp((s) => s.client);
  const session = useApp((s) => s.session);
  const me = useApp((s) => s.me);
  const [works, setWorks] = useState<Work[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.works().then(setWorks, (e: Error) => setError(e.message));
  }, []);

  const open = currentWorld(session?.placements ?? []);
  const worlds = works.filter((w) => w.outputKind === "world" && w.latest);

  return (
    <div className={ui.section}>
      <div className={ui.sectionHead}>
        <h3 className={ui.sectionTitle}>開いているワールド</h3>
      </div>
      <p className={ui.muted}>
        公開されているワールドから選びます。開くと、3秒後にいまのワールドは入れ替わります。
      </p>
      {open ? (
        <p className={ui.item} style={{ cursor: "default" }}>
          <span className={ui.itemName}>{open.outputName}</span>
          <span className={ui.badgeBrand}>開いています</span>
        </p>
      ) : (
        <p className={ui.muted}>まだ開いていません。</p>
      )}
      <h3 className={ui.sectionTitle}>公開されているワールド</h3>
      {error && <p className={ui.error}>{error}</p>}
      {worlds.length === 0 ? (
        <p className={ui.muted}>公開されたワールドはまだありません。</p>
      ) : (
        <ul className={ui.list} aria-label="公開されているワールド">
          {worlds.map((w) => {
            const releaseId = w.latest?.id;
            const opened = releaseId !== undefined && open?.releaseId === releaseId;
            const canUse = w.perms.use || w.owner === me?.id;
            return (
              <li key={w.id} className={ui.item} style={{ cursor: "default" }}>
                <span className={ui.itemName}>
                  {w.name}
                  <span className={ui.muted}>
                    {" "}
                    · {w.ownerName} / {w.repoName}
                  </span>
                </span>
                {w.latest && <span className={ui.badge}>v{w.latest.version}</span>}
                {opened ? (
                  <span className={ui.badgeBrand}>開いています</span>
                ) : (
                  <button
                    type="button"
                    className={ui.btn}
                    style={{ height: 26 }}
                    disabled={!releaseId || !canUse}
                    title={
                      canUse
                        ? "3秒後に、セッションの全員のワールドが変わります"
                        : "利用の権限がありません"
                    }
                    onClick={() => {
                      if (releaseId) client.send({ t: "session.openWorld", releaseId });
                    }}
                  >
                    開く
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
