// scripts/gen-official-thumbnails.mjs が書く。手で書き換えない。

/** 公式ライブラリのサムネイルの素材 ID（中身の SHA-256。ADR 0046） */
export const OFFICIAL_THUMBNAILS = {
  combat: "de95042e0d49343948c1abeeac88ebf4ab15e87dddb46a39d57ddfb468e9db1d",
  interaction: "a756993c8900c8d4de346b71e5e9dc78e44b128183eebc4f8efeb79c77277822",
  items: "232025d518f49691b9917bf2d7c9de3be3a313376f095a6966a35d03d2c139e4",
} as const;
