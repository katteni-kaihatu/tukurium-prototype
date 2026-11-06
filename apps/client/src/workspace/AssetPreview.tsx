import { useEffect, useRef, useState } from "react";
import { assetUrl } from "../net/api";
import styles from "./AssetPreview.module.css";

/** テクスチャの見た目。 */
export function ImagePreview({ id, name }: { id: string; name: string }) {
  return <img src={assetUrl(id)} alt={name} className={styles.image} />;
}

/** モデルの見た目。開いているあいだだけ描く。 */
export function ModelPreview({ id }: { id: string }) {
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
        const view = sizeOf(el);
        const renderer = new THREE.WebGLRenderer({ canvas: el, alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(view.width, view.height, false);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(35, view.width / view.height, 0.01, 100);
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
            if (!(obj instanceof THREE.Mesh)) return;
            obj.geometry.dispose();
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const mat of mats) {
              for (const value of Object.values(mat)) {
                if (value instanceof THREE.Texture) value.dispose();
              }
              mat.dispose();
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
  if (failed) return <p className={styles.empty}>表示できません</p>;
  return <canvas ref={canvas} className={styles.canvas} aria-label="モデルの見た目" />;
}

/** マテリアルの見た目。色・粗さ・金属感・画像を、いまの値のまま球に出す。 */
export function MaterialPreview({
  color,
  roughness,
  metalness,
  map,
}: {
  color: string;
  roughness: number;
  metalness: number;
  map: string | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ color, roughness, metalness, map });
  latest.current = { color, roughness, metalness, map };
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let stop = false;
    let frame = 0;
    let dispose = () => {};
    void import("three")
      .then((THREE) => {
        if (stop) return;
        const view = sizeOf(el);
        const renderer = new THREE.WebGLRenderer({ canvas: el, alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(view.width, view.height, false);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(35, view.width / view.height, 0.01, 10);
        camera.position.set(1.5, 0.95, 1.9);
        camera.lookAt(0, 0, 0);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.15));
        const sun = new THREE.DirectionalLight(0xffffff, 1.25);
        sun.position.set(2.2, 3.2, 4);
        scene.add(sun);
        const geo = new THREE.SphereGeometry(0.72, 48, 32);
        const mat = new THREE.MeshStandardMaterial();
        const mesh = new THREE.Mesh(geo, mat);
        scene.add(mesh);
        const loader = new THREE.TextureLoader();
        let mapId: string | null = null;
        let tex: import("three").Texture | null = null;
        let released = false;
        const apply = () => {
          const now = latest.current;
          mat.color.set(now.color);
          mat.roughness = now.roughness;
          mat.metalness = now.metalness;
          if (now.map === mapId) return;
          mapId = now.map;
          tex?.dispose();
          tex = null;
          mat.map = null;
          mat.needsUpdate = true;
          if (!now.map) return;
          const loading = now.map;
          loader.load(assetUrl(loading), (next) => {
            if (stop || latest.current.map !== loading) {
              next.dispose();
              return;
            }
            next.colorSpace = THREE.SRGBColorSpace;
            tex = next;
            mat.map = next;
            mat.needsUpdate = true;
          });
        };
        dispose = () => {
          if (released) return;
          released = true;
          cancelAnimationFrame(frame);
          tex?.dispose();
          geo.dispose();
          mat.dispose();
          renderer.dispose();
        };
        const tick = () => {
          if (stop) return;
          frame = requestAnimationFrame(tick);
          apply();
          mesh.rotation.y += 0.008;
          renderer.render(scene, camera);
        };
        tick();
      })
      .catch(() => {
        if (!stop) setFailed(true);
      });
    return () => {
      stop = true;
      dispose();
    };
  }, []);
  if (failed) return <p className={styles.empty}>表示できません</p>;
  return <canvas ref={canvas} className={styles.canvas} aria-label="マテリアルの見た目" />;
}

function sizeOf(el: HTMLCanvasElement): { width: number; height: number } {
  return {
    width: el.clientWidth || 360,
    height: el.clientHeight || 180,
  };
}
