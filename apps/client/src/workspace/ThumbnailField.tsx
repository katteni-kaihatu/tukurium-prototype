import type { OutputDef, ProjectDoc } from "@tukurium/repo-model";
import { useCallback, useState } from "react";
import { useThumbnailCamera } from "../session/ThumbnailCamera";
import { ImagePreview } from "./AssetPreview";
import { uploadAsset } from "./assets";
import { useProject } from "./hooks";
import styles from "./ThumbnailField.module.css";
import ui from "./ui.module.css";

/** 撮った画像を置くフォルダの名前（いちばん上。なければ作る） */
const THUMBNAIL_FOLDER = "サムネイル";

/**
 * アウトプットのサムネイル（ADR 0046）。Resources にある画像から選ぶ。
 * 「カメラを出す」で空間にカメラを置き、持って動かして映る範囲を決め、「撮る」でサムネイルにする。
 * 撮った画像は Resources の「サムネイル」フォルダに足す。
 */
export function ThumbnailField(props: {
  output: OutputDef;
  editing: boolean;
  onChange: (thumbnail: string | undefined) => void;
}) {
  const project = useProject();
  const camera = useThumbnailCamera((s) => s.camera);
  const shown = useThumbnailCamera((s) => s.shown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useCallback(
    (el: HTMLCanvasElement | null) => camera?.setPreview(el),
    [camera],
  );
  const images = project.assets().filter((a) => a.kind === "image");
  const current = images.find((a) => a.id === props.output.thumbnail) ?? null;

  const shoot = async () => {
    if (!camera) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await camera.capture();
      const file = new File([blob], `${props.output.name} のサムネイル.png`, { type: "image/png" });
      const uploaded = await uploadAsset(file);
      const folder = thumbnailFolder(project);
      const asset = project.siblingNameTaken(uploaded.name, folder, uploaded.id)
        ? { ...uploaded, name: project.freeName(uploaded.name, folder) }
        : uploaded;
      project.addAsset(asset);
      project.moveResource(asset.id, folder);
      props.onChange(asset.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={ui.section}>
      <div className={ui.sectionHead}>
        <h3 className={ui.sectionTitle}>サムネイル</h3>
      </div>
      <p className={ui.muted}>
        アイテム・マーケット・プロジェクトの一覧に出す画像です。Resources にある画像から選びます。
      </p>
      {current ? (
        <div className={styles.current}>
          <ImagePreview id={current.id} name={current.name} />
        </div>
      ) : (
        props.output.thumbnail && (
          <p className={ui.error}>指定した画像が Resources にありません。選び直してください。</p>
        )
      )}
      <div className={ui.row}>
        <label className={ui.label} htmlFor={`thumb-${props.output.id}`}>
          画像
        </label>
        <select
          id={`thumb-${props.output.id}`}
          className={ui.select}
          value={current?.id ?? ""}
          disabled={!props.editing}
          onChange={(e) => props.onChange(e.target.value || undefined)}
        >
          <option value="">（なし）</option>
          {images.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      {props.editing && (
        <div className={styles.cameraBox}>
          <div className={ui.toolbar}>
            <button
              type="button"
              className={ui.btn}
              disabled={!camera}
              title={
                camera ? "目の前にカメラを出します" : "セッションの空間を開いているときに使えます"
              }
              onClick={() => camera?.show()}
            >
              {shown ? "カメラを目の前に呼ぶ" : "カメラを出す"}
            </button>
            {shown && (
              <button type="button" className={ui.btn} onClick={() => camera?.hide()}>
                カメラをしまう
              </button>
            )}
          </div>
          {shown && (
            <>
              <canvas
                ref={previewRef}
                className={styles.preview}
                aria-label="カメラに映っているもの"
              />
              <p className={ui.muted}>
                空間に入り、カメラを右クリックで持って動かします（持ったままホイールで前後）。
              </p>
              <button
                type="button"
                className={ui.btnPrimary}
                disabled={busy}
                onClick={() => void shoot()}
              >
                {busy ? "撮っています…" : "撮ってサムネイルにする"}
              </button>
            </>
          )}
          {error && <p className={ui.error}>{error}</p>}
        </div>
      )}
    </div>
  );
}

/** いちばん上の「サムネイル」フォルダ。なければ作る */
function thumbnailFolder(project: ProjectDoc): string {
  const found = project.folders().find((f) => f.parent === null && f.name === THUMBNAIL_FOLDER);
  return found?.id ?? project.addFolder(THUMBNAIL_FOLDER, null);
}
