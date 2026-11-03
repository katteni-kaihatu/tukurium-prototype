# ADR 0012：権限の単位・境界・判定の場所（authority）・対象の policy

- 状態：採用
- 関連：ADR 0005（セッションとホスト）、ADR 0006（セッションの世界）、ADR 0008（権限）、ADR 0011（役割）
- 詳細計画：[`../plans/ugc-api-library-permissions.md`](../plans/ugc-api-library-permissions.md)

## 背景

セッションでは、別々の作者の Item / World の出力を、一つの物理空間に「配置」として置く。今は配置の間に境界がない。characterization test（`packages/runtime/src/ugcBoundary.characterization.test.ts`）で、次を確かめた。

- Raycast は、別の配置の Entity の生の ID を返す。
- `world.find` は、配置をまたいで名前で探せる。
- `world.emit` は、別の配置の Entity に任意のイベントを送れる。
- `world.destroy` は、別の配置の Entity も消せる。
- `world.get` / `world.set` は、呼んだ側の KokoState の名前で引くので、別の領域の状態には届かない（偶然の境界）。
- 組み込みの入力（grab など）は、入力に書かれた `player` をそのまま信じる。サーバーも書き換えずに中継する。

また、セッションの実行は参加者のブラウザ（ホスト）が担っている。ホストの Runtime で権限を強制しても、改造されたホストからは守れない。

## 決定

利用者と相談して、次のように決めた。

### 1. 権限は「置いた物（Placement）」に与える

- 実際の権限は「Package / System が宣言した必要な Capability」∩「置いた物への付与」∩「World の上限」∩「対象が公開しているもの」∩「Player の役割」とする。どれか一つでも欠ければ拒む。
- 明示的な拒否（deny）は、どの許可よりも優先する。Item や Package が World の拒否を上書きすることはできない。
- 利用者のスクリプトが申告した player・対象 ID・権限は信じない。Runtime が、接続・配置・System・Package から実行の主体（`PackageExecutionContext`）を組み立てる。

### 2. 権限の境界は「セッションに置いた World ごと」

- セッションに置いた World の出力の一つひとつに `WorldInstanceId` を振り、それを一つの境界（security domain）とする。
- Item は、置いた先の World の policy に従う。
- 別の World へは、明示的な Bridge（Portal・Message channel など）がなければ届かない。座標が近いことは境界にならない。

### 3. 見えない対象は「見つからない」

- 非公開の対象への操作は、「存在しない」と同じ結果を返す。存在そのものを漏らさない。
- 公開されているが、その操作が許されていないときだけ「権限がない」と返す。
- 作者向けの問題（Diagnostic）でも、この区別を保つ。拒否の診断が、非公開のものの存在を漏らさないようにする。

### 4. 判定の場所：今は協調セッションに限る

- 当面は「ホストを信頼する協調セッション」に限り、ホストの Runtime gateway で権限を強制する。これで、正規のクライアントの上で動く UGC からは守れる。
- 別の持ち主の永続状態を変える操作、権限の変更、競争の結果などは、サーバーでの判定が要る。今はそれを作らないので、表では「サーバーの判定が必要（未実装）」と明記し、画面でも「保護済み」とは表示しない。サーバーでの判定は U2 以降で別に作る。

### 5. 操作ごとの判定の場所（authority matrix）

正本は `packages/runtime/src/capabilities.ts` の `HOST_API_POLICY`。全 Host API が分類されていることをテストで検査する。

| Host API | Capability | 今届く範囲 | U1 / U2 での別の配置への扱い | 判定の場所 |
| --- | --- | --- | --- | --- |
| `time.now` | time.read | 自分の領域 | 対象を取らない | ホスト |
| `audio.play` | audio.play | 自分の領域 | 拒む | ホスト（配る分の quota は将来サーバー） |
| `world.raycast` | physics.raycast | 全配置（U2：別の配置は opaque handle だけ。private には当たらない） | 対象が公開した Collider だけ。結果は opaque handle | ホスト |
| `world.emit` | interaction.send | 自分の配置（U2） | 拒む。別の配置へは contract.send | サーバーの再検証が必要（未実装） |
| `contract.send`（`hit.send`） | interaction.send | 全配置（U2：相手が interactive のときだけ） | 対象が公開した Contract だけ | サーバーの再検証が必要（未実装） |
| `world.find` | entity.discover | 自分の配置（U1） | 拒む（自分の配置の中だけ） | ホスト |
| `world.get` | state.read | 自分の配置（U1） | 対象の policy で公開した state だけ | ホスト |
| `world.set` | state.write | 自分の配置（U1） | 対象の policy で許した state だけ | サーバーの再検証が必要（未実装） |
| `world.spawn` | entity.spawn | 自分の配置（U1） | 拒む（一時的な effect は effects.spawn に分ける） | サーバーの再検証が必要（未実装） |
| `world.destroy` | entity.destroy | 自分の配置（U1） | 拒む（自分の配置の中だけ） | サーバーの再検証が必要（未実装） |
| 組み込みの入力の player | — | 申告どおり | 接続から本人を決める | サーバーで実行が必要（未実装） |

### 6. handle と付与の寿命

- Raycast の結果は、生の Entity ID の代わりに、ホストの表を引く推測しにくい token（opaque handle）にする。発行した主体・配置・World・実行の版・期限を表に持ち、使うたびに再検証する。
- handle は、apply・reset・ホストの引き継ぎ・版の更新で無効にする。同じ JSON を作る・別の System に渡す・保存して後で使う・別の World へ送る、のどれでも使えない。
- 付与（grant）は配置のデータから毎回組み立て直すので、ホストの引き継ぎでは新しいホストが同じ付与を作り直す。handle は引き継がない。
- Contract の要求（Damage など）には、判定する側が発行する request ID を付け、同じ要求の再送・二重配送を一度だけ適用する。順序・保持期間・引き継ぎ時の扱いは U2 で決めてテストで固定する。

## 結果

### U1 でしたこと

- Host API の引数は、一つの定義（`packages/runtime/src/hostApi.ts` の `HOST_API_ARGS`。zod）で `unknown` から検証する。今まで黙って無視していた引数は「無いもの」として扱い、例外にしていた引数（座標・Entity の ID・イベント名）は例外にする。
- 呼び出しの主体の配置は、呼んだときに処理していた Entity から決める（サンドボックスが渡す）。ハンドラの外では、その System を使っている配置すべてとする。
- `world.find` / `get` / `set` / `destroy` と `spawn` の親、`audio.play` の音源の Entity は、呼んだ System の配置の中だけにした。別の配置は「見つからない」と同じ結果になる。`world.spawn` で作った Entity は、呼んだ System の配置のものになる。
- U1 の最初の slice では、`world.raycast` と `world.emit` に別の配置への正当な使い道が残っていた。U2 の最初の縦切りで、Raycast は別の配置の生 Entity ID を返さない opaque handle に、別の配置への通知は公開 Contract に置き換えた。要求 Capability と effective grant の強制が未実装なので、U1 全体はまだ途中である。

### U1 の続き：実効権限（宣言 ∩ 付与）

利用者と相談して、次のように決めた。

- 要る Capability は、利用者が書くのではなく、System のコードから AST で読み取る（`inferCapabilities`）。`world.raycast` → physics.raycast、`hit.send` → interaction.send、`hit.effect` → effects.spawn のように対応させる。対応表（`HOST_CAPABILITIES`）は `HOST_API_POLICY` と一致することをテストで検査する。`world[name]()` や `const w = world` のように読み取れない使い方は、その行の注意にする。
- 置いた物への付与（`PartSpec.grants`）は、指定がなければ宣言をそのまま付与する。付与はサーバーの配置の台帳（`Placement.grants`、null は宣言どおり）に持ち、セッションの持ち主・置いた人・そのワークスペースの共同編集以上が `setGrants` で変えられる。ホストには `host.setGrants` で届く（PROTOCOL_VERSION 3）。細かく取り消す画面は U5 で作る。
- 強制はセッションだけにかけ、ワークスペースの再生ではかけない。
- セッションでは、Host API を呼ぶたびに「その System の宣言にあり、呼び出しの主体の配置すべてに付与されている」かを判定する。外れたら、見つからない・できなかったのと同じ値を返し、その System に注意（`capability-denied`）を残す。System は止めない。別の配置への届き方（World の上限・相手の公開範囲）は、これまでどおりそれぞれの Host API の中で判定する。
- 実行の主体（`PackageExecutionContext`）は、Package の仕組みができるまで、ワークスペースの出力を暗黙の Package（`workspace:<リポジトリ>`）とし、版は realm の版、置いた物は配置、World は土台の World（ないときは `session`）で組み立てる（`Simulation.executionContext`）。

### U2 の最初の縦の一本でしたこと

利用者と相談して、書き方と初期設定を次のように決めた。

- 受ける側は、System に `contracts: { Damage(e, damage) { ... } }` と書く。書いた Contract だけが外に公開される。受ける Entity は Query で決まる。
- 送る側は、`const hit = world.raycast(...); if (hit) hit.send("Damage", { amount })` と書く。`hit` は opaque handle で、別の配置に当たったときは位置・距離・token だけが見え、`hit.entity` は null になる。自分の配置に当たったときだけ、生の Entity ID が入る。
- Contract は、Package（U3）ができるまでは公式の Built-in として持つ。最初は Damage v1（`amount`：0〜1,000,000 の数、`type`：32 文字までの文字列。ほかのキーは拒む）。
- アウトプットの「外からの見え方」（`exposure`）の初期値は「インタラクション可能」。今ある作品は、受ける側を `contracts` の書き方に直せば、別の作者の銃で撃てる。
  - `interactive`：公開した Contract を受け付ける
  - `collision`：Raycast は当たるが、Contract は受け付けない（権限がない）
  - `private`：別の配置からは Raycast も当たらない（見つからない）

handle は、発行した配置からだけ・一度だけ・1 秒の間だけ使える。配置の追加・削除・リセット・適用・復元（ホストの引き継ぎ）で、発行済みの handle はすべて無効になる。一度だけ使えることで、同じ要求の二重配送を防いでいる。

一時的な effect：`hit.effect("spark", { color, size, life })` で、handle の当たった点にだけ出せる（相手が「衝突のみ」でも出せる。非公開には当たらないので出せない）。handle 一つにつき一つ、大きさは 1m まで、寿命は 2 秒まで、1 フレームに 32 個まで。effect は保存も物理もせず、音と同じようにホストが手元で出して、状態と一緒にほかの人へ配る。Contract と effect は、同じ handle でそれぞれ一度ずつ使える。

World の上限：利用者と相談して、プリセットだけを作った。セッションでは最初に置いた World を土台とし、土台の World と別の作者の Item（外から来た Item）には、土台の World の `guestPolicy` がかかる（初期値はインタラクション可能）。

- `deny`（許さない）：外から来た Item からは、自分の配置の外は見つからない
- `collision`（衝突のみ）：Raycast と一時的な effect まで。Contract は送れない
- `interactive`（インタラクション可能）：相手が公開した Contract も送れる

実際に届くかは「外から来た Item への上限 ∩ 相手の公開範囲（exposure）」で決まる。土台の World と同じ作者の Item、World 自身には上限をかけない。あとから置いた World の上限は、外から来た Item にかからない（World が複数あるときの扱いは後で決める）。Placement grant の runtime model と強制は U1 の Capability gateway で作り、細かな設定 UI は U5 で追加する。

拒否の知らせ：公開されている相手（Raycast が当たった相手）に Contract を拒まれたとき（相手が「衝突のみ」、または土台の World が許していないとき）は、送った System に注意（`contract-denied`）を残す。同じ注意は回数を数え、System の状態（`SystemStatus.warnings`）としてほかの人にも配る。ワークスペースの「問題」とセッションのパネル（このワークスペースの System の分だけ）に出す。非公開の相手・偽の handle などは「見つからない」と同じなので、注意も出さない（存在を漏らさない）。

まだ残っているもの：要求 Capability と Placement grant の runtime model / 強制、サーバーでの判定。細かな設定 UI は U5。

### この先

- U1 の残りとして、要求 Capability と Placement grant の runtime model / 強制を実装する。U2 の残りとして、別所有者に影響する操作の Server authority を実装する。U5 には設定 UI だけを残す。
- U3 で Package identity / dependency lock を実装した後、U4 の reference UGC から必要性を確認した公式 Platform Primitive / Library を段階的に昇格させる。
