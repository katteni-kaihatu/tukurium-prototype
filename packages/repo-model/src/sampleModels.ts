// scripts/gen-sample-models.mjs が書く。手で書き換えない。
// バイト列は apps/server/src/sampleModels.generated.ts にあり、サーバーが起動時に素材置き場へ入れる。

export const SAMPLE_MODEL = {
  pine: {
    id: "b083a2f6572cec19f3e70104c52a611a9ff44c180091e075ae68692134deba6b",
    name: "松",
    kind: "model" as const,
    contentType: "model/gltf-binary",
  },
  leaf: {
    id: "e99dff3986be3ffefd9e60f647760817fbdd800473b0d180fbb08380002ad1d0",
    name: "広葉樹",
    kind: "model" as const,
    contentType: "model/gltf-binary",
  },
  bush: {
    id: "de988e397915fbb76a5bb503c035ae239a1503494e1f2a7232b4d93f1f15b6ff",
    name: "灌木",
    kind: "model" as const,
    contentType: "model/gltf-binary",
  },
} as const;
