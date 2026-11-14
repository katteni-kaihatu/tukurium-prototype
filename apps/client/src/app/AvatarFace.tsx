import { useState } from "react";
import styles from "./AvatarFace.module.css";

/**
 * 顔（丸い枠）の中身。アイコン（Misskey のアバター）があれば画像、なければ名前の 1 文字目（ADR 0074）。
 * 丸い枠そのものと状態の丸は、置く側の CSS が描く
 */
export function AvatarFace({
  user,
}: {
  user: { name: string; avatarUrl?: string | null } | null | undefined;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const url = user?.avatarUrl;
  if (url && broken !== url)
    return (
      <img
        className={styles.image}
        src={url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(url)}
      />
    );
  return <>{user?.name.trim().slice(0, 1) || "?"}</>;
}
