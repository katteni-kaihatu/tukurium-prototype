import type { ReactNode } from "react";
import type { ChangeKind } from "./changeMarks";
import ui from "./ui.module.css";

/** 行の左端に、変化の丸を置く。丸の分はいつも空けて、出たり消えたりでずれないようにする。 */
export function MarkedLine({ kind, children }: { kind: ChangeKind | null; children: ReactNode }) {
  return (
    <div className={ui.markedLine}>
      <ChangeMark kind={kind} />
      <div className={ui.markedBody}>{children}</div>
    </div>
  );
}

/** 新しいものは緑、変わったものは黄色の丸。色だけに頼らず名前も付ける。 */
export function ChangeMark({
  kind,
  nested = false,
}: {
  kind: ChangeKind | null;
  /** 閉じた階層の中にある変化 */
  nested?: boolean;
}) {
  const label =
    kind === null
      ? null
      : nested
        ? kind === "added"
          ? "中に新しいものがあります"
          : "中に変わったものがあります"
        : kind === "added"
          ? "新しい"
          : "変わった";
  if (!label || !kind) return <span className={ui.changeMark} />;
  return (
    <span
      className={ui.changeMark}
      data-change={kind}
      title={label}
      role="img"
      aria-label={label}
    />
  );
}
