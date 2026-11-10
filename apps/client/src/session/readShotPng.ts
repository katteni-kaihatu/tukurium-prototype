import type * as THREE from "three";

/** 撮影用の描画先を、上下を返した PNG の base64 にする（WebGL の行は下から上） */
export function readShotPng(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
): string {
  const { width, height } = target;
  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を作れませんでした");
  const image = ctx.createImageData(width, height);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  }
  ctx.putImageData(image, 0, 0);
  const url = canvas.toDataURL("image/png");
  const comma = url.indexOf(",");
  return comma >= 0 ? url.slice(comma + 1) : url;
}
