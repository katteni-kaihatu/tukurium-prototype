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
| `world.raycast` | physics.raycast | **全配置** | 対象が公開した Collider だけ。結果は opaque handle | ホスト |
| `world.emit` | interaction.send | **全配置** | 対象が公開した Contract だけ | サーバーの再検証が必要（未実装） |
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
- `world.raycast` と `world.emit` は、別の配置への正当な使い道（別のリポジトリの銃で的を撃つ）の代わりができるまで、まだ別の配置に届く。U2 で opaque handle と公開 Contract に置き換える。この 2 つが残る間は、U1 を完了とはしない。

### この先

- U1 で、全 Host API を一つの Capability gateway に通す。`HOST_API_POLICY` で「全配置」に届いている 4 つ（raycast・emit・find・destroy）は、U1 / U2 で上の表のとおりに直す。そのとき characterization test を意図して書き換える。
- 最初の縦の一本（U2）：外部の銃が、保護された World の公開 Collider を Raycast し、内部の Entity / KokoState を取らずに、当たった点へ一時的な effect を出し、公開された Damage Contract だけを呼ぶ。
- U1 で満たすことの一つ（「Raycast の結果に別の配置の生の Entity ID が含まれない」）を、`it.fails` のテストとして置いてある。満たしたら `it` に変える。
