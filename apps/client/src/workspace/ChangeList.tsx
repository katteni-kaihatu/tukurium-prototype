import { useEffect, useRef, useState } from "react";
import { assetUrl } from "../net/api";
import { type DiffEntry, type DiffLine, diffKindLabel } from "./diffView";
import styles from "./history.module.css";

/** 名前で並べた差分。行を押すと、階層や欄、コード、見た目を出す。 */
export function ChangeList({ entries }: { entries: DiffEntry[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (entries.length === 0) return <p className={styles.emptyDiff}>差分はありません</p>;
  const groups = new Map<string, DiffEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.group) ?? [];
    list.push(entry);
    groups.set(entry.group, list);
  }
  return (
    <div className={styles.groups}>
      {[...groups.values()].map((list) => (
        <section key={list[0]?.group} aria-label={list[0]?.groupLabel}>
          <h5 className={styles.groupTitle}>
            {list[0]?.groupLabel}
            <span className={styles.groupCount}>{list.length}</span>
          </h5>
          <ul className={styles.tree}>
            {list.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={styles.change}
                  aria-expanded={open === entry.id}
                  data-change={entry.kind}
                  onClick={() => setOpen(open === entry.id ? null : entry.id)}
                >
                  <span className={styles.changeName}>{entry.name}</span>
                  {entry.hint && <span className={styles.changeHint}>{entry.hint}</span>}
                  <span className={styles.kind}>{diffKindLabel(entry.kind)}</span>
                </button>
                {open === entry.id && <ChangeDetail entry={entry} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ChangeDetail({ entry }: { entry: DiffEntry }) {
  return (
    <div className={styles.changeDetail}>
      {entry.lines.length > 0 && (
        <ul className={styles.lines}>
          {withKeys(
            entry.lines,
            (line) => `${line.label}\0${line.before ?? ""}\0${line.after ?? ""}`,
          ).map(({ item: line, key }) => (
            <li key={key}>
              <span className={styles.lineLabel}>{line.label}</span>
              <LineValue line={line} />
            </li>
          ))}
        </ul>
      )}
      {entry.code && entry.code.length > 0 && (
        <pre className={styles.code}>
          {withKeys(entry.code, (row) => `${row.kind}:${row.text}`).map(({ item: row, key }) => (
            <div key={key} data-kind={row.kind}>
              {row.kind === "add"
                ? "+ "
                : row.kind === "del"
                  ? "− "
                  : row.kind === "gap"
                    ? ""
                    : "  "}
              {row.text}
            </div>
          ))}
        </pre>
      )}
      {entry.preview && <PreviewPair entry={entry} />}
    </div>
  );
}

function withKeys<T>(items: T[], baseOf: (item: T) => string): { item: T; key: string }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = baseOf(item);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { item, key: `${base}#${n}` };
  });
}

function LineValue({ line }: { line: DiffLine }) {
  if (line.before === line.after) return <Value text={line.before ?? "（なし）"} />;
  return (
    <span className={styles.lineValues}>
      <Value text={line.before ?? "（なし）"} tone={line.before === null ? undefined : "del"} />
      <span className={styles.arrow}>→</span>
      <Value text={line.after ?? "（なし）"} tone={line.after === null ? undefined : "add"} />
    </span>
  );
}

function Value({ text, tone }: { text: string; tone?: "add" | "del" }) {
  const color = /^#[0-9a-fA-F]{3,8}$/.test(text);
  return (
    <span className={tone === "add" ? styles.addText : tone === "del" ? styles.delText : undefined}>
      {color && <span className={styles.swatch} style={{ background: text }} />}
      {text}
    </span>
  );
}

function PreviewPair({ entry }: { entry: DiffEntry }) {
  const preview = entry.preview;
  if (!preview) return null;
  return (
    <div className={styles.pair}>
      <figure className={styles.preview}>
        <figcaption>変更前</figcaption>
        {preview.beforeId ? (
          <Thumb kind={preview.kind} id={preview.beforeId} name={entry.name} />
        ) : (
          <p className={styles.previewEmpty}>なし</p>
        )}
      </figure>
      <figure className={styles.preview}>
        <figcaption>変更後</figcaption>
        {preview.afterId ? (
          <Thumb kind={preview.kind} id={preview.afterId} name={entry.name} />
        ) : (
          <p className={styles.previewEmpty}>なし</p>
        )}
      </figure>
    </div>
  );
}

function Thumb({ kind, id, name }: { kind: "model" | "image"; id: string; name: string }) {
  if (kind === "image") {
    return <img src={assetUrl(id)} alt={name} className={styles.previewImg} />;
  }
  return <ModelThumb id={id} />;
}

/** 開いているあいだだけ、モデルを小さな画面で回す。 */
function ModelThumb({ id }: { id: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let stop = false;
    let frame = 0;
    let dispose = () => {};
    void import("three")
      .then(async (THREE) => {
        if (stop) return;
        const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
        if (stop) return;
        const renderer = new THREE.WebGLRenderer({ canvas: el, alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(el.clientWidth, el.clientHeight, false);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(
          35,
          el.clientWidth / Math.max(1, el.clientHeight),
          0.01,
          100,
        );
        scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.3));
        const sun = new THREE.DirectionalLight(0xffffff, 1.1);
        sun.position.set(2, 3, 4);
        scene.add(sun);
        let model: import("three").Object3D | null = null;
        const tick = () => {
          if (stop) return;
          frame = requestAnimationFrame(tick);
          if (model) model.rotation.y += 0.012;
          renderer.render(scene, camera);
        };
        let released = false;
        dispose = () => {
          if (released) return;
          released = true;
          cancelAnimationFrame(frame);
          scene.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.geometry.dispose();
              const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
              for (const mat of mats) mat.dispose();
            }
          });
          renderer.dispose();
        };
        try {
          const gltf = await new GLTFLoader().loadAsync(assetUrl(id));
          if (stop) {
            dispose();
            return;
          }
          model = gltf.scene;
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          model.position.sub(center);
          scene.add(model);
          const max = Math.max(size.x, size.y, size.z, 0.001);
          camera.position.set(max * 0.9, max * 0.7, max * 1.8);
          camera.lookAt(0, 0, 0);
          tick();
        } catch {
          if (!stop) setFailed(true);
          dispose();
        }
      })
      .catch(() => {
        if (!stop) setFailed(true);
      });
    return () => {
      stop = true;
      dispose();
    };
  }, [id]);
  if (failed) return <p className={styles.previewEmpty}>表示できません</p>;
  return <canvas ref={canvas} className={styles.previewCanvas} aria-label="モデルの見た目" />;
}
