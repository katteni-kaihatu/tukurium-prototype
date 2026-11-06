// 公式ライブラリのサムネイル（640×360 の PNG。ADR 0046）を作る。
// 絵は下の SVG で描き、Playwright で PNG にする。実行すると、ID（中身の SHA-256）を repo-model に、
// サーバーが起動時に置くバイト列を apps/server に書き出す。
//   node scripts/gen-official-thumbnails.mjs
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const W = 640;
const H = 360;

/** 公式ライブラリごとの絵。背景の色・アイコン（SVG のパス）・見出し */
const LIBRARIES = [
  {
    key: "combat",
    title: "combat",
    sub: "Health と Damage",
    bg: ["#f6e3e6", "#e9c3cb"],
    ink: "#8a2f45",
    icon: `<path d="M120 196c-46-30-78-58-78-94 0-24 19-42 42-42 15 0 28 8 36 20 8-12 21-20 36-20 23 0 42 18 42 42 0 36-32 64-78 94z" fill="#c8506a"/>
      <path d="M150 58l-18 40h26l-30 54 8-38h-24l20-56z" fill="#fff" opacity="0.92"/>`,
  },
  {
    key: "interaction",
    title: "interaction",
    sub: "押す・開ける・切り替える",
    bg: ["#e2eef4", "#bfd9e6"],
    ink: "#1f5e73",
    icon: `<rect x="52" y="54" width="136" height="136" rx="28" fill="#2a6b8a"/>
      <rect x="84" y="86" width="72" height="72" rx="36" fill="#fdd046"/>
      <circle cx="120" cy="122" r="16" fill="#2a6b8a"/>`,
  },
  {
    key: "items",
    title: "items",
    sub: "鍵と拾える物",
    bg: ["#f6efd9", "#ecdcaa"],
    ink: "#7a5a12",
    icon: `<circle cx="86" cy="122" r="38" fill="none" stroke="#e2b322" stroke-width="20"/>
      <rect x="118" y="112" width="86" height="20" rx="6" fill="#e2b322"/>
      <rect x="170" y="124" width="14" height="30" rx="4" fill="#e2b322"/>
      <rect x="146" y="124" width="12" height="22" rx="4" fill="#e2b322"/>`,
  },
];

const page = (lib) => `<!doctype html><html><body style="margin:0">
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${lib.bg[0]}"/><stop offset="1" stop-color="${lib.bg[1]}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <circle cx="560" cy="-20" r="150" fill="#fff" opacity="0.25"/>
  <circle cx="40" cy="380" r="110" fill="#fff" opacity="0.2"/>
  <g transform="translate(44 58)">${lib.icon}</g>
  <text x="290" y="168" font-family="sans-serif" font-size="54" font-weight="700" fill="${lib.ink}">${lib.title}</text>
  <text x="292" y="214" font-family="sans-serif" font-size="24" fill="${lib.ink}" opacity="0.8">${lib.sub}</text>
  <text x="292" y="262" font-family="sans-serif" font-size="18" font-weight="700" fill="#603d56" opacity="0.85">Tukurium 公式ライブラリ</text>
</svg></body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const out = [];
for (const lib of LIBRARIES) {
  await tab.setContent(page(lib));
  const png = await tab.locator("svg").screenshot({ type: "png" });
  const id = createHash("sha256").update(png).digest("hex");
  out.push({ key: lib.key, id, base64: png.toString("base64") });
}
await browser.close();

const header = "// scripts/gen-official-thumbnails.mjs が書く。手で書き換えない。\n\n";
writeFileSync(
  "packages/repo-model/src/officialThumbnails.generated.ts",
  `${header}/** 公式ライブラリのサムネイルの素材 ID（中身の SHA-256。ADR 0046） */\nexport const OFFICIAL_THUMBNAILS = {\n${out
    .map((o) => `  ${o.key}: "${o.id}",`)
    .join("\n")}\n} as const;\n`,
);
writeFileSync(
  "apps/server/src/officialThumbnails.generated.ts",
  `${header}export const OFFICIAL_THUMBNAIL_BLOBS = [\n${out
    .map(
      (o) =>
        `  {\n    id: "${o.id}",\n    name: "${o.key}",\n    contentType: "image/png",\n    base64:\n      "${o.base64}",\n  },`,
    )
    .join("\n")}\n];\n`,
);
console.log(out.map((o) => `${o.key} ${o.id} ${o.base64.length}`).join("\n"));
