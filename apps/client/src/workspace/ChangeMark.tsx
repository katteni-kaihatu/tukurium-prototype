import type { ReactNode } from "react";
import type { ChangeKind } from "./changeMarks";
import { useWorkspace } from "./store";
import ui from "./ui.module.css";

/** 行の左端に、変化の丸を置く。変化がない行も透けた丸にして、文字の開始を揃える。 */
export function MarkedLine({ kind, children }: { kind: ChangeKind | null; children: ReactNode }) {
  return (
    <div className={ui.markedLine}>
      <ChangeMark kind={kind} />
      <div className={ui.markedBody}>{children}</div>
    </div>
  );
}

/** 新しいものは緑、変わったものは黄色、変化がないものは中が透けた丸。色だけに頼らず名前も付ける。 */
export function ChangeMark({
  kind,
  nested = false,
}: {
  kind: ChangeKind | null;
  /** 閉じた階層の中にある変化 */
  nested?: boolean;
}) {
  const edit = useWorkspace((s) => s.mode === "edit");
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
  if (!label || !kind) {
    return <span className={edit ? ui.changeMark : ui.changeGap} aria-hidden="true" />;
  }
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
