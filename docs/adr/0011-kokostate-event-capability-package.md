# ADR 0011：KokoState・Event・Capability・Package の役割

- 状態：採用
- 関連：ADR 0010（リソースの同一性）、ADR 0012（権限と判定の場所）、ADR 0013（Package）
- 詳細計画：ロードマップの「別々の作品を中身を壊さず組み合わせて部品として使う」

## 背景

今は、続く状態（弾の数）も、一時的な出来事（撃った・当たった）も、ホストの機能（Raycast・音）も、KokoState・`world.emit`・`world.*` のどれかで済ませている。UGC が他の Item / World と関わるようになる前に、それぞれの役割を分ける。分けないと、入力のたびに boolean を立てて誰かが消すような設計や、何でも KokoState に入れて公開してしまう設計が標準になる。

## 決定

| もの | 役割 | 例 | 保存・同期 |
| --- | --- | --- | --- |
| **KokoState** | 続く状態。保存・同期・復元・Inspector の表示の対象 | Health・Inventory・Transform・Gun（弾の数・威力） | する |
| **Event / Action** | 一時的な出来事。届いたら終わる | fire・reload・hit | しない |
| **Contract** | 外に公開する操作の型。入力の schema と、対象側の受け付け方（policy）を持つ | Damage v1（amount・type） | しない |
| **Capability** | ホストの機能を使う権利 | physics.raycast・audio.play・effects.spawn | 設定は保存する |
| **Package** | コードと定義の出所・版・必要な Capability をまとめた単位 | 銃の部品、公式の入力ライブラリ | する（ADR 0013） |

- 入力の押下を KokoState の boolean として立て、後で誰かが消す設計を標準にしない。入力は Event として届ける。
- 相手の内部の KokoState を共有して相互作用するのではなく、相手が公開した Contract を呼ぶ。Damage を受けた側は、内部で Health・Shield・無敵時間などを自由に実装できる。
- ホストの機能は、すべて Capability として名前を付け、一つの gateway を通す（ADR 0012）。今ある Host API の分類は `packages/runtime/src/capabilities.ts` の `HOST_API_POLICY` に置く。
- Capability の ID は `名前空間.操作`（例：`physics.raycast`）。意味を変えるときは version（整数）を上げる。Contract は Package・名前・major version で識別する。

## 結果

- 今の `world.emit(entity, "hit", data)` は、U2 で「対象が公開した Contract を呼ぶ」形に置き換える。それまでは、今の動きを characterization test（`ugcBoundary.characterization.test.ts`）で固定しておく。
- 銃のサンプルは、弾の数・威力・クールダウンだけを KokoState に残し、入力の変換・Raycast・Damage・effect は公式の Library へ移す（U4）。
