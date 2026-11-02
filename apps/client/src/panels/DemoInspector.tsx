import { useId, useState } from "react";
import styles from "./DemoInspector.module.css";

/** パネル基盤の確認用。2D / 3D を切り替えても入力中の値が保たれることを確かめる。 */
export function DemoInspector() {
  const id = useId();
  const [name, setName] = useState("Gun");
  const [ammo, setAmmo] = useState(12);
  const [color, setColor] = useState("#603d56");
  const [kept, setKept] = useState(true);

  return (
    <>
      <div className={styles.row}>
        <label htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className={styles.row}>
        <label htmlFor={`${id}-ammo`}>ammo</label>
        <input
          id={`${id}-ammo`}
          type="range"
          min={0}
          max={30}
          value={ammo}
          onChange={(e) => setAmmo(Number(e.target.value))}
        />
        <output htmlFor={`${id}-ammo`}>{ammo}</output>
      </div>
      <div className={styles.row}>
        <label htmlFor={`${id}-color`}>Color</label>
        <input
          id={`${id}-color`}
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
        <code>{color.toUpperCase()}</code>
      </div>
      <div className={styles.row}>
        <input
          id={`${id}-keep`}
          type="checkbox"
          checked={kept}
          onChange={(e) => setKept(e.target.checked)}
        />
        <label htmlFor={`${id}-keep`} className={styles.inline}>
          適用時に値を引き継ぐ
        </label>
      </div>
      <p className={styles.note}>
        右上のピンで「画面に固定」と「空間に置く」を切り替えられます。Esc
        でマウスを解放すると空間のパネルを操作できます。
      </p>
    </>
  );
}
