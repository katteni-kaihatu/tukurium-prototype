import * as THREE from "three";

/** 距離と縮小率に合わせて線を消し、遠景のちらつきを抑える床。目盛りは 20 cm / 1 m。 */
export function createGridGround(): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> {
  const material = new THREE.MeshStandardMaterial({
    color: "#171c24",
    roughness: 1,
    // 空間全体の明るい霧で床まで白くしない。線だけを遠くで消す。
    fog: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.gridMinorColor = { value: new THREE.Color("#2b3542") };
    shader.uniforms.gridMajorColor = { value: new THREE.Color("#637186") };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vGridPosition;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvGridPosition = (modelMatrix * vec4(position, 1.0)).xz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform vec3 gridMinorColor;
uniform vec3 gridMajorColor;
varying vec2 vGridPosition;

float gridLine(vec2 position, float spacing, float thickness) {
  vec2 cell = position / spacing;
  vec2 footprint = max(fwidth(cell), vec2(0.00001));
  vec2 distanceToLine = abs(fract(cell + 0.5) - 0.5) / footprint;
  vec2 coverage = 1.0 - smoothstep(vec2(0.0), vec2(thickness), distanceToLine);
  // 画面上で細かくなりすぎた線は、方向ごとに消す。
  coverage *= 1.0 - smoothstep(vec2(0.15), vec2(0.5), footprint);
  return max(coverage.x, coverage.y);
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
float gridDistance = length(vGridPosition - cameraPosition.xz);
float minor = gridLine(vGridPosition, 0.2, 1.0) * (1.0 - smoothstep(5.0, 22.0, gridDistance));
float major = gridLine(vGridPosition, 1.0, 1.25) * (1.0 - smoothstep(18.0, 75.0, gridDistance));
diffuseColor.rgb = mix(diffuseColor.rgb, gridMinorColor, minor);
diffuseColor.rgb = mix(diffuseColor.rgb, gridMajorColor, major);`,
      );
  };
  material.customProgramCacheKey = () => "session-grid-ground-v1";

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), material);
  ground.name = "session-grid-ground";
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.updateMatrix();
  return ground;
}
