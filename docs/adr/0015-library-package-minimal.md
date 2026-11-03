# ADR 0015：最小の Library Package（ライブラリの作品・公開の印・content hash）

- 状態：採用（2026-11-03）
- 関連：ADR 0007（作品・リリース）、ADR 0010（論理パス・import）、ADR 0013（Package の同一性・版）
- 詳細計画：[`../plans/ugc-api-library-permissions.md`](../plans/ugc-api-library-permissions.md) の U3

## 背景

ADR 0013 で Package の考え方（安定 ID・書き換えない版・exports・依存の lock）を決めた。今ある「作品」と「リリース」の仕組みに載せて、最小の形を作る。

## 決定（利用者と決めたこと）

1. **Package はライブラリの作品とそのリリースで作る**。Output の Kind に「ライブラリ」を足す。Package ID は作品の ID、版はリリースの番号。
2. **使う側はプロジェクトの依存に足して import する**。依存には別名・Package ID・版・content hash を固定して書き、`import Gun from "@別名/Gun.koko"` のように書く（次の段階で入れる）。
3. **外から import できるのは「公開」の印を付けたものだけ**。印は KokoState・System・Material・素材に付けられる。フォルダと Built-in には付けない。
4. **Damage は今は Built-in のまま**。公式 Library へ移すのは U4。

## 形

- 公開の印は制作データに保存する（Y.Doc の `exports`、Snapshot の `exports`、Git の `exports.json`）。
- Package の中身（manifest）は、公開したリソースを ID の順に並べ、それぞれの論理パスと定義を持つ（`packageManifest`）。公開していないものは入らない。
- content hash は、サーバーがリリースのときに manifest を並べ方を決めた JSON（キーを並べ替える `stableStringify`）にして SHA-256 をかけて計算し、リリースに残す。クライアントの申告は使わない。
- 同じ作品・同じ版が違う hash で出ていたら拒む。取り出すとき（`GET /api/works/:id/releases/:version/package`）も計算し直して確かめる。
- 取り出せるのは、作品の「利用」が許されている人と持ち主。
- ライブラリの作品はセッションに置けない（置くものではなく、import して使う）。編集空間では Item と同じ置き方で見る。

## 結果

- 内部（公開していないもの）だけを変えて出し直しても、hash は変わらない。使う側は hash の違いで中身の違いを知れる。
- 公開したリソースの論理パスは、その版の時点のものを manifest に残す。名前やフォルダを変えると、次の版では別のパスになる（使う側は lock した版を使い続ける）。
- 依存・`@別名/...` の import・「見つからない」「公開されていない」の診断・実行時の取り込み・依存グラフの辺・抽出／フォークでの出所の保持は、次の段階で入れる。
