import { useApp } from "../app/store";
import ui from "../workspace/ui.module.css";
import { listBelongings } from "./belongings";

const manageTitle = "外せるのは、出した人、セッションの持ち主、元のワークスペースの共同編集者です";

/**
 * セッションの持ち物。
 * セッションに置いてあるもの（ワークスペースから出したものと、公開された作品）の一覧。
 * 編集中のワークスペースのリソースやリンク先とは別で、セッションが持っている。
 */
export function SessionBelongings() {
  const client = useApp((s) => s.client);
  const session = useApp((s) => s.session);
  const me = useApp((s) => s.me);
  const placements = session?.placements ?? [];
  const names = new Map((session?.participants ?? []).map((p) => [p.id, p.name]));
  const rows = session ? listBelongings(placements, session, me?.id ?? null, names) : [];

  return (
    <div className={ui.section}>
      <div className={ui.sectionHead}>
        <h3 className={ui.sectionTitle}>置いてあるもの</h3>
        <span className={ui.badge}>{rows.length}</span>
      </div>
      <p className={ui.muted}>
        セッションに置いてあるものです。いま開いているワークスペースの中身とは別で、セッションが持っています。
      </p>
      {rows.length === 0 ? (
        <p className={ui.muted}>まだ何も置いてありません。</p>
      ) : (
        <ul className={ui.list} aria-label="セッションの持ち物">
          {rows.map((row) => (
            <li key={row.id} className={ui.item} style={{ cursor: "default" }}>
              <span className={ui.itemName}>
                {row.title}
                <span className={ui.muted}>
                  {" "}
                  · {row.from} · {row.position} · {row.by}
                </span>
              </span>
              {row.published && <span className={ui.badge}>作品</span>}
              <button
                type="button"
                className={ui.btn}
                style={{ height: 26 }}
                disabled={!row.canManage}
                title={row.canManage ? "いまの制作データの初期値に戻す" : manageTitle}
                onClick={() => client.send({ t: "resetPart", placementId: row.id })}
              >
                リセット
              </button>
              <button
                type="button"
                className={ui.iconBtn}
                aria-label={`${row.title} を外す`}
                title={row.canManage ? "セッションから外す" : manageTitle}
                disabled={!row.canManage}
                onClick={() => client.send({ t: "unplace", placementId: row.id })}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
