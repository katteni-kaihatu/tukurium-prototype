# ADR 0049：空の Entity には Transform を付けず、詳細の下の追加ボタンは出さない

- 状態: 採用・実装済み
- 関連：ADR 0040（Hierarchy から Entity を作る）、ADR 0044（KokoState を追加する付属パネル）、ADR 0048（詳細の操作）

## 理由

空の Entity を作ると Transform が付いていた。何も持たないものとして作りたいときに、外す手間があった。詳細の下の「KokoState を追加」は、Inspector の端のつまみと同じ付属パネルを開くだけで、詳細の場所を取っていた。

## 決定

- Hierarchy の「空の Entity」と、詳細の「子 Entity を作る」は、KokoState を付けない。
- ボックスなどの形を選んだときは、これまでどおり Transform と Mesh を付ける。
- Inspector の詳細の下に、「KokoState を追加」ボタンは出さない。付けるのは、Inspector の端のつまみから開く付属パネルで行う。
- 詳細の上の段の操作（複製・削除・子 Entity を作る…）に、「KokoState を追加」のアイコンも置く。押すと、端のつまみと同じ付属パネルを開く（2026-11-07 に足した。つまみに気づかなくても付けられるように）。
