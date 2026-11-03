import { Euler, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { placeFromView, poseInView, viewQuaternion } from "./transform";

describe("視点の姿勢", () => {
  it("FPS のカメラ（ロール 0）と同じ向きになる", () => {
    const cam = new PerspectiveCamera();
    for (const [pitch, yaw] of [
      [0, 0],
      [0.4, 1.2],
      [-0.8, -2],
      [1.2, 0.3],
    ] as const) {
      cam.rotation.set(pitch, yaw, 0, "YXZ");
      cam.updateMatrixWorld();
      const dir = cam.getWorldDirection(new Vector3());
      const q = viewQuaternion([dir.x, dir.y, dir.z]);
      expect(q.angleTo(cam.quaternion)).toBeLessThan(1e-5);
    }
  });

  it("視点からの差を戻すと、元の位置と角度になる", () => {
    const origin: [number, number, number] = [1, 2, 3];
    const cam = new PerspectiveCamera();
    cam.rotation.set(0.2, -0.7, 0, "YXZ");
    cam.updateMatrixWorld();
    const dir = cam.getWorldDirection(new Vector3()).toArray() as [number, number, number];
    const position: [number, number, number] = [4, 1.2, -2];
    const rotation: [number, number, number] = [15, -40, 25];
    const pose = poseInView(origin, dir, position, rotation);
    const back = placeFromView(origin, dir, pose.offset, pose.rotation);
    expect(back.position[0]).toBeCloseTo(position[0], 5);
    expect(back.position[1]).toBeCloseTo(position[1], 5);
    expect(back.position[2]).toBeCloseTo(position[2], 5);
    const a = new Quaternion().setFromEuler(
      new Euler(
        (rotation[0] * Math.PI) / 180,
        (rotation[1] * Math.PI) / 180,
        (rotation[2] * Math.PI) / 180,
        "XYZ",
      ),
    );
    const b = new Quaternion().setFromEuler(
      new Euler(
        (back.rotation[0] * Math.PI) / 180,
        (back.rotation[1] * Math.PI) / 180,
        (back.rotation[2] * Math.PI) / 180,
        "XYZ",
      ),
    );
    expect(a.angleTo(b)).toBeLessThan(1e-4);
  });
});
