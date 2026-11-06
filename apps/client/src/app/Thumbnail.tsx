import { assetUrl } from "../net/api";
import styles from "./Thumbnail.module.css";

/**
 * アウトプットのサムネイル（ADR 0046）。画像がなければ何も出さない（呼ぶ側が代わりを出す）。
 * size は一覧の小さい印（small）か、カードいっぱい（fill）。
 */
export function Thumbnail({
  id,
  name,
  size = "fill",
}: {
  id: string | null | undefined;
  name: string;
  size?: "fill" | "small";
}) {
  if (!id) return null;
  return (
    <img
      src={assetUrl(id)}
      alt={`${name} のサムネイル`}
      className={size === "small" ? styles.small : styles.fill}
      loading="lazy"
    />
  );
}
