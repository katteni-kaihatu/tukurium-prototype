// 森のサンプルに置く木の GLB を作る。
// 実行すると、ID（中身の SHA-256）と、サーバーが起動時に置くバイト列を書き出す。
//   node scripts/gen-sample-models.mjs
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const lin = (srgb) => srgb ** 2.2;

/** 0..1 の sRGB を、glTF のリニアな色にする */
function color(r, g, b) {
  return [lin(r), lin(g), lin(b), 1];
}

function mesh() {
  return { positions: [], normals: [], indices: [], parts: [] };
}

function addCylinder(m, y0, y1, r0, r1, seg) {
  const start = m.positions.length / 3;
  const indexStart = m.indices.length;
  const dy = y1 - y0;
  const slope = r0 - r1;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const nx = c * dy;
    const ny = slope;
    const nz = s * dy;
    const len = Math.hypot(nx, ny, nz) || 1;
    m.positions.push(c * r0, y0, s * r0, c * r1, y1, s * r1);
    m.normals.push(nx / len, ny / len, nz / len, nx / len, ny / len, nz / len);
  }
  for (let i = 0; i < seg; i++) {
    const b = start + i * 2;
    m.indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  return { indexStart, count: m.indices.length - indexStart };
}

function addSphere(m, cx, cy, cz, r, seg) {
  const start = m.positions.length / 3;
  const indexStart = m.indices.length;
  const lat = Math.max(4, Math.floor(seg / 2));
  for (let y = 0; y <= lat; y++) {
    const v = (y / lat) * Math.PI;
    for (let x = 0; x <= seg; x++) {
      const u = (x / seg) * Math.PI * 2;
      const nx = Math.sin(v) * Math.cos(u);
      const ny = Math.cos(v);
      const nz = Math.sin(v) * Math.sin(u);
      m.positions.push(cx + nx * r, cy + ny * r, cz + nz * r);
      m.normals.push(nx, ny, nz);
    }
  }
  const stride = seg + 1;
  for (let y = 0; y < lat; y++) {
    for (let x = 0; x < seg; x++) {
      const i = start + y * stride + x;
      m.indices.push(i, i + stride, i + 1, i + 1, i + stride, i + stride + 1);
    }
  }
  return { indexStart, count: m.indices.length - indexStart };
}

function part(m, range, c) {
  m.parts.push({ ...range, color: c });
}

function pine() {
  const m = mesh();
  const bark = color(0.45, 0.3, 0.18);
  const g1 = color(0.16, 0.34, 0.2);
  const g2 = color(0.22, 0.42, 0.24);
  const g3 = color(0.3, 0.5, 0.3);
  part(m, addCylinder(m, 0, 1.2, 0.12, 0.07, 8), bark);
  part(m, addCylinder(m, 0.82, 2.15, 0.98, 0.02, 10), g1);
  part(m, addCylinder(m, 1.5, 2.8, 0.74, 0.02, 10), g2);
  part(m, addCylinder(m, 2.15, 3.45, 0.48, 0, 8), g3);
  return m;
}

function broadleaf() {
  const m = mesh();
  const bark = color(0.38, 0.25, 0.15);
  const a = color(0.2, 0.42, 0.24);
  const b = color(0.28, 0.5, 0.3);
  const c = color(0.16, 0.36, 0.22);
  const d = color(0.34, 0.55, 0.32);
  part(m, addCylinder(m, 0, 1.45, 0.16, 0.09, 8), bark);
  part(m, addSphere(m, 0, 2.25, 0, 0.95, 12), a);
  part(m, addSphere(m, -0.55, 2.05, 0.22, 0.62, 10), b);
  part(m, addSphere(m, 0.52, 2.1, -0.18, 0.58, 10), c);
  part(m, addSphere(m, 0.08, 2.85, 0.08, 0.52, 10), d);
  return m;
}

function bush() {
  const m = mesh();
  const bark = color(0.36, 0.26, 0.16);
  const a = color(0.24, 0.44, 0.26);
  const b = color(0.32, 0.52, 0.3);
  const c = color(0.18, 0.38, 0.22);
  part(m, addCylinder(m, 0, 0.28, 0.05, 0.04, 6), bark);
  part(m, addSphere(m, 0, 0.55, 0, 0.42, 10), a);
  part(m, addSphere(m, 0.22, 0.46, 0.1, 0.3, 8), b);
  part(m, addSphere(m, -0.2, 0.42, -0.06, 0.26, 8), c);
  return m;
}

function glb(m) {
  const pos = new Float32Array(m.positions);
  const nor = new Float32Array(m.normals);
  const idx = new Uint16Array(m.indices);
  if (m.positions.length / 3 > 65535) throw new Error("頂点が多すぎます");
  const posBytes = Buffer.from(pos.buffer);
  const norBytes = Buffer.from(nor.buffer);
  const idxBytes = Buffer.from(idx.buffer);
  const idxPad = (4 - (idxBytes.length % 4)) % 4;
  const bin = Buffer.concat([posBytes, norBytes, idxBytes, Buffer.alloc(idxPad)]);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
  }

  const materials = [];
  const primitives = m.parts.map((p, i) => {
    materials.push({
      name: `m${i}`,
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: p.color,
        metallicFactor: 0,
        roughnessFactor: 0.92,
      },
    });
    return {
      attributes: { POSITION: 0, NORMAL: 1 },
      indices: 2 + i,
      material: i,
    };
  });

  const accessors = [
    {
      bufferView: 0,
      componentType: 5126,
      count: pos.length / 3,
      type: "VEC3",
      min,
      max,
    },
    { bufferView: 1, componentType: 5126, count: nor.length / 3, type: "VEC3" },
    ...m.parts.map((p) => ({
      bufferView: 2,
      byteOffset: p.indexStart * 2,
      componentType: 5123,
      count: p.count,
      type: "SCALAR",
    })),
  ];

  const json = {
    asset: { version: "2.0", generator: "tukurium-sample-models" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Tree", mesh: 0 }],
    meshes: [{ primitives }],
    materials,
    accessors,
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: posBytes.length, byteLength: norBytes.length, target: 34962 },
      {
        buffer: 0,
        byteOffset: posBytes.length + norBytes.length,
        byteLength: idxBytes.length,
        target: 34963,
      },
    ],
    buffers: [{ byteLength: bin.length }],
  };

  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonChunk, bh, bin]);
}

const models = [
  { key: "pine", name: "松", mesh: pine() },
  { key: "leaf", name: "広葉樹", mesh: broadleaf() },
  { key: "bush", name: "灌木", mesh: bush() },
];

const built = models.map((model) => {
  const bytes = glb(model.mesh);
  if (bytes.readUInt32LE(0) !== 0x46546c67) throw new Error("GLB の見出しが違います");
  const id = createHash("sha256").update(bytes).digest("hex");
  return { ...model, bytes, id };
});

const ids = built
  .map(
    (m) => `  ${m.key}: {
    id: "${m.id}",
    name: "${m.name}",
    kind: "model" as const,
    contentType: "model/gltf-binary",
  },`,
  )
  .join("\n");

writeFileSync(
  new URL("../packages/repo-model/src/sampleModels.ts", import.meta.url),
  `// scripts/gen-sample-models.mjs が書く。手で書き換えない。
// バイト列は apps/server/src/sampleModels.generated.ts にあり、サーバーが起動時に素材置き場へ入れる。

export const SAMPLE_MODEL = {
${ids}
} as const;
`,
);

const blobs = built
  .map(
    (m) => `  {
    id: "${m.id}",
    name: "${m.name}",
    contentType: "model/gltf-binary",
    base64: "${m.bytes.toString("base64")}",
  },`,
  )
  .join("\n");

writeFileSync(
  new URL("../apps/server/src/sampleModels.generated.ts", import.meta.url),
  `// scripts/gen-sample-models.mjs が書く。手で書き換えない。

export const SAMPLE_MODEL_BLOBS = [
${blobs}
] as const;
`,
);

for (const m of built) console.log(m.key, m.id, m.bytes.length);
