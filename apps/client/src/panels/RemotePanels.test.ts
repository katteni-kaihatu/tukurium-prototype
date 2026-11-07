import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CAMERA_FOV, EYE_HEIGHT } from "../session/FpsController";
import { PANEL_METERS_PER_PX } from "./PanelSpace";
import { placeOnView } from "./RemotePanels";

/** 持ち主のカメラで、空間の点が画面のどこ（px）に写るか */
function project(
  point: THREE.Vector3,
  pose: { position: [number, number, number]; yaw: number; pitch: number },
  view: { w: number; h: number },
) {
  const cam = new THREE.PerspectiveCamera(CAMERA_FOV, view.w / view.h, 0.05, 500);
  cam.position.set(pose.position[0], pose.position[1] + EYE_HEIGHT, pose.position[2]);
  cam.rotation.set(pose.pitch, pose.yaw, 0, "YXZ");
  cam.updateMatrixWorld();
  const p = point.clone().project(cam);
  return { x: ((p.x + 1) / 2) * view.w, y: ((1 - p.y) / 2) * view.h };
}

describe("他の人の 2D パネルの置き方", () => {
  const view = { w: 1280, h: 720 };
  const pose = { position: [3, 0, -2] as [number, number, number], yaw: 0.7, pitch: -0.2 };
  const panel = {
    screen: { x: 300, y: 200, viewWidth: view.w, viewHeight: view.h },
    size: { width: 400, height: 300 },
  };

  it("持ち主の画面と同じ所・同じ大きさに見える", () => {
    const mesh = new THREE.Object3D();
    placeOnView(mesh, pose, panel, 0, 1);
    mesh.updateMatrixWorld();
    const center = project(mesh.position, pose, view);
    expect(center.x).toBeCloseTo(300, 0);
    expect(center.y).toBeCloseTo(200, 0);
    // パネルの左右の端（ローカルの ±幅/2）が、画面でも幅 400px に写る
    const half = (panel.size.width / 2) * PANEL_METERS_PER_PX;
    const left = project(mesh.localToWorld(new THREE.Vector3(-half, 0, 0)), pose, view);
    const right = project(mesh.localToWorld(new THREE.Vector3(half, 0, 0)), pose, view);
    expect(right.x - left.x).toBeCloseTo(400, -1);
  });

  it("画面の位置がなければ、持ち主の正面に並べる", () => {
    const mesh = new THREE.Object3D();
    placeOnView(mesh, { ...pose, pitch: 0 }, { ...panel, screen: null }, 0, 1);
    const center = project(mesh.position, { ...pose, pitch: 0 }, { w: 1280, h: 720 });
    expect(center.x).toBeCloseTo(640, 0);
    expect(center.y).toBeCloseTo(360, 0);
  });
});
