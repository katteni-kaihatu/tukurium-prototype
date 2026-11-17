# 0082: プレハブを型で扱い、実行中の書き込みをすぐ届ける

日付: 2026-11-16

ロードマップの「プレハブを型で扱ってコードからインスタンスを作る」の判断をまとめる。段階ごとの進み具合は、その実装計画にある。作っていない所は「これから」と書く。

## 判断

### 1. 書き込みは、Host API の境目で World と合わせる（実装済み）

`e.get(X).y = 1` で書いた値は、Entity の値を読み書きする Host API を呼ぶ直前と、System の呼び出しの終わりに、ホストの World へ書く。一度に動く System は一つで、呼び出しの途中にほかから World を読めるのは Host API を通るときだけなので、利用者からは、書いたその場で届いたのと同じに見える。

- **合わせる Host API**：`world.get`・`world.set`・`world.getState`・`world.setState`・`world.getField`・`world.setField`・`world.spawn`・`world.destroy`（`Simulation` の `SYNC_HOST_API`）。時刻・音・バッグ・effect は Entity の値を見ないので、合わせない。イベントと Contract は、呼び出しが終わってから届くので、合わせない。Entity の値を読み書きする Host API を足したら、ここにも足す。
- **送る範囲**：前に合わせてから回した Entity と、いまの Entity。QuickJS の中で、Entity の値を文字にして、前に送った文字と比べ、変わったものだけを送る。`e.get()` で触れたものを覚える案は、Host API を呼ばない System でも `e.get()` のたびに手間がかかるので、取らない。回した順番で決める。
- **前の Entity の値を変数に持って、あとで書き換えたとき**：呼び出しの終わりに届く。それまでの Host API からは、前に合わせたときの値が見える。
- **比べる相手は、最後に合わせた値**。呼び出しの初めの値と比べると、途中で届けた値を初めの値へ戻したときに、届かなくなる。
- **ホストが書いた値を返す**：Host API が書いたフィールド（Entity・KokoState・フィールド名）を覚え、戻り値の前に添えて返す。QuickJS の側は、持っている値のオブジェクトに、そのフィールドだけを書く。同じオブジェクトを書き換えるので、`const g = e.get(Gun)` で持っている値にも届く。ほかのフィールドは、スクリプトが持っている値のまま。
- **取らない案**：`e.get()` の値を Proxy にして、書くたびにホストへ送る。書くたびに境界をまたぎ、読むのも遅くなる。

重さ（Entity 1000 個を回す System。1 ステップの時間。`pnpm bench:sim`）：

| System | 前 | あと |
| --- | --- | --- |
| Host API を呼ばない | 15.8 ms | 15.4〜16.8 ms |
| Entity ごとに `time.now()`（合わせない Host API） | 37.7 ms | 37〜40 ms |
| 書いてから `world.get` で読む | 50.9 ms | 69〜73 ms（約 1.4 倍） |
| Entity ごとに、自分へ `world.set` で書く | 48.0 ms | 91〜97 ms（約 1.9 倍） |

Host API を呼ばない System と、Entity の値を見ない Host API は変わらない。自分へ `world.set` で書く形は、ホストへ送り、ホストから返すので、いちばん重い。この形の約 1.9 倍は、受け入れる（計画者に確認した。`@deprecated` にした古い書き方で、`e.get()` に書けば重くならない）。あわせて、Host API の引数と戻り値の読み書きを軽くした（値の形式のタグがなければ、ふつうの JSON として扱う）。

### 2. System に Entity を渡す前に確かめる（実装済み）

Host API の戻り値に、その呼び出しで消えた Entity（子も含む）と、Query に合わなくなった Entity を添える。QuickJS の側は一覧を持ち、順に回すときに照らして飛ばす。消えた Entity の値は、フィールドを「読むと `undefined` を返し、書いた値を捨てる」形に置き換える。`e.get()` も、この同じオブジェクトを返す（`undefined` を返すと、`e.get(X).y` が例外になり、System が止まるため）。読み書きしたことは、System の注意（`entity-gone`）として出す。System は止めない。消えた Entity は、合わせるときと、呼び出しの終わりの書き出しから外す。

今は、呼び出しの途中で KokoState を付け外しする Host API がないので、飛ばすのは消えた Entity だけ。

`onUpdate` の途中で作り、いま動いている System の Query に合う Entity は、同じ呼び出しの並びの後ろに足す。`onEvent`・`onCollision`・`onInput`・Contract には足さない。**一つの呼び出しで足せるのは 256 個まで**（1 ステップのイベントの上限と同じ）。超えた分は、次に呼ばれたときから渡す。

### 3. デバッグ実行（実装済み）

非同期版でも同じ仕組みを使う（`Simulation.beginRun()` を、ふつうの再生とデバッグ実行で共用する）。一時停止の所も、合わせる境目にする：止まるときに、スクリプトが持っている値を World へ書く。これで、止まった画面に、まだ返していない `e.get()` の変更が出る。続けるときに World を元へ戻す処理（ADR 0080 の「値の表示と実行の整合」）は、やめた。停止中に利用者が変えた値は、World に書き、待機の返り値でスクリプトへも渡す（今までと同じ）。

前の Entity の値を変数に持って書き換えた分も、止まった画面には出る（一時停止では、渡した Entity すべての値を写すため）。

### 4. 型の書き方（宣言を作る所まで実装済み。`Prefab.spawn`・`Prefab.destroy` は、これから）

```ts
type PrefabType<B, P, I> = string & {
  readonly __tukurium: "Prefab";
  readonly __prefab: B;
  readonly __create: (params: P) => I;
};
type PrefabInstance<B> = EntityRef & { readonly __instance: B };
type InstanceOf<T> = T extends PrefabType<any, any, infer I> ? I : never;
```

- `B` は、自分と、たどれるすべての元のプレハブの ID を並べた印（`{ id_駒: true; id_赤い駒: true }`）。バリアントは元の印に当てはまり、同じ構造の別のプレハブは当てはまらない。
- `__create` の引数は反変で確かめられるので、必須のパラメータを足したバリアントは、元のプレハブ型に当てはまらない。
- 印のプロパティは必須にする。省略できると、ふつうの `EntityRef` も当てはまり、制作データの Entity を `Prefab.destroy` に渡せてしまう。
- パラメータのないプレハブの `P` は `{ [name: string]: never }` にする。`{}` は、どんなオブジェクトも受けてしまう。
- `Prefab.spawn<T>(prefab: T, ...params): InstanceOf<T> | undefined`。必須のパラメータがあれば第二引数は必須、なければ省略できる。作れなかったとき（権限がない・依存でたどれない・上限を超える）は `undefined` を返す。
- `Prefab.destroy(instance: PrefabInstance<{}>): boolean`。

この決まりは `packages/typecheck/src/prefabTypes.test.ts` で確かめている。

宣言の作り方：

- プレハブごとに宣言ファイル（`/Bullet.prefab.d.ts`）を作り、`export default` で値（プレハブ型）を出す。インスタンス型は `InstanceOf<typeof Bullet>`。
- 印とパラメータは、repo-model の `prefabTypeInfo()` が作る。バリアント（いちばん上の Entity が、別のプレハブのインスタンスになっているプレハブ）は、元の ID を印に持ち、元のパラメータを受け継ぐ。
- 「このプレハブは、このプレハブ型に当てはまるか」は、同じ決まりを `prefabFitsType()`（repo-model）にも置く。Inspector の候補・値の確かめ・実行中の確かめは、これを使う。
- パラメータの型は、指すフィールドの型を、その KokoState の宣言から引く（`FieldsOf<K>["名前"]`）。説明は JSDoc にする。
- System は、プレハブ・マテリアル・素材を、値として default import できる。値は、リソースの ID の文字（`const Bullet = "<ID>"` に書き換える）。型は、プレハブ型・`MaterialRef`・`ModelRef`・`TextureRef`・`AudioRef`。
- 定義へ移動で、プレハブを開く。import のパスの候補に、プレハブ・マテリアル・素材を出す。

### 5. 値の形（import した値は実装済み。フィールドの型は、これから）

- プレハブの値は、プレハブの ID の文字。`import Bullet from "./Bullet.prefab"` は `const Bullet = "<ID>"` に書き換える。セッションでも、領域を付けずに制作データの ID のまま持ち、作るときに、呼んだ配置の版の制作データで引く。System が触れるのは自分の配置の Entity だけなので、読む配置と作る配置がいつも同じになる。
- インスタンスの値は、作ったいちばん上の Entity の ID。
- `ValueSchema` に `{ kind: "prefab", prefab }` と `{ kind: "prefabInstance", prefab }` を足す。「なし」は `undefined`。インスタンス型のフィールドは、制作データでは必ず「なし」。
- KokoState のフィールドの型の文では、KokoState の「import するプレハブ」（`prefabImports`。プレハブの ID と、型の文で使う名前）で付けた名前で指す。足すときに名前が重なるなら、初めの名前に `Prefab` を付ける。

### 6. パラメータ（実装済み。実行中に渡す所は、これから）

`PrefabDef.params`：パラメータの ID → 名前・指すフィールド（ルートからの Entity の ID・KokoState・フィールド）・必須・説明・順番。

- 制作データに置いたインスタンスでは、値は今の上書きそのもの。Inspector の「プレハブの設定」は、上書きを書く別の入口になる。
- いちばん上の Entity の Transform を指すパラメータは、インスタンスの Transform に結び付ける。置いたインスタンスは、いつも Transform を持つので、必須でも問題にしない。
- 問題（エラー）：指す先がない（`prefab-param-target-missing`）、名前が重なる（`prefab-param-name-collision`）、名前が空（`prefab-param-name-invalid`）、置いたインスタンスが必須の値を決めていない（`prefab-param-required`）。
- 必須の問題は、プレハブのいちばん上の Entity（バリアントの元のインスタンス）には出さない。プレハブの中に置いたインスタンスは、外側のプレハブの必須のパラメータがそのフィールドを指していれば、埋まったものとする。
- 共同編集では、`params` をまとめて一つのキーで持つ（プレハブの定義の、ほかのキーと同じ持ち方）。二人が同じプレハブの別のパラメータを同時に変えると、あとの人のものが残る。プロトタイプの間は、これで足りるとする。
- ライブラリの読み込みと抽出では、パラメータが指す Entity と KokoState の ID も付け替える。

### 7. 実行中に作る・消す（実装済み）

- 作れるのは、その配置から依存でたどれるプレハブだけ（セッションの境界。ADR 0012）。
- **配置ごとに、実行中に作れる Entity は 1000 個まで**（ID が `rt:` で始まるものを数える。プレハブの中の Entity も一つずつ数える）。`world.spawn` にもかける。フレームで配る状態が、Entity 500 個でおよそ 330 KB になるため。
- 作ったいちばん上の Entity → プレハブの ID の対応（`spawnedFrom`）を、フレーム・ホストの引き継ぎ・デバッグ実行の巻き戻しの点に入れる。Entity がどの口で消えても外す。
- 入れ子のインスタンスは、インスタンス型のフィールドに入れられるが、`Prefab.destroy` では消せない。
- プレハブの System は、配置のときに先に読み込み、そのプレハブのインスタンスがある間だけ動かす。印は System と配置の組ごと。「入・切」は ADR 0076 の足し合わせに従う。
- 適用とリセットで、実行中に作ったインスタンスは消える。

作り方：

- `Prefab.spawn`・`Prefab.destroy` は Host API（Capability は `entity.spawn`・`entity.destroy`）。
- 作るたびに展開し直さないよう、プレハブごとのひな形（プレハブを一つだけ展開した Entity の並び）を、制作データ（配置の版）ごとに取っておく。作るときは、ID を付け替えて、パラメータを重ねる。
- World に入れるときは、配置を作るときと同じ処理（`Simulation.addEntities()`）を通す。パラメータで渡した値は、すでに実行中の値なので、付け替えずに、型の確かめだけを通す。
- 型の合わない値・ないパラメータ・足りない必須のパラメータは、使わずに System の注意として出す（作りはする）。
- 依存でたどれるプレハブは、アウトプットの System の import・置いたインスタンス・プレハブの System の import・入れ子・バリアントの元からたどる（`reachablePrefabs()`）。輪になっていても止まる。
- Entity を、スクリプトが消したときは、配置の Entity の一覧・名前・`spawnedFrom` からも外す。
- World は、親から子を引く索引を持つ。
- プレハブの System は、依存でたどれるプレハブのものを、配置のとき（`loadSystems`）に、アウトプットの System の後ろへ読み込む。スクリプトの呼び出しの途中（`Prefab.spawn` の中）では、読み込めないため。
- 読み込んだだけの System は、その配置で、そのプレハブ（か、それを中に含むプレハブ）のインスタンスを実行中に作って、残っている間だけ動かす（`Simulation.awake()`）。残っているかは `spawnedFrom` から求めるので、通信の形は増えない。
- 呼び出しの途中で作ると、同じフレームの、あとの System から動く。
- `spawnedFrom` は、再生のフレーム・セッションのフレーム・デバッグ実行の巻き戻しの点に `spawned` として入れる。ないフレームは「作ったものはない」として読むので、通信の版は上げない。引き継いだホストでも、`Prefab.destroy` で消せ、プレハブの System が動き続ける。

### 8. そのほか

- `Prefab` は、リソースの名前に使えない（予約語。実装済み。`reserved-name`）。大文字・小文字は区別し、フォルダは対象にしない。
- 静的に危ない Host API に `@deprecated` を付ける（実装済み）。
  - `HOST_API_SPEC` の項目に、理由と代わりの書き方（`deprecated: { reason, instead }`）を持たせる。持つものは、安定度が `deprecated` になり、宣言に `@deprecated` が付く。
  - 付けたもの：`world.get`・`world.set`・`world.getState`・`world.setState`・`world.getField`・`world.setField`・`world.emit`・`world.find`・`world.spawn`・`world.destroy`・`world.raycast`・`audio.play`。Entity を ID の文字で受け取る・返すもの、名前で探す・作る・消すもの。作ったインスタンスを読み書きする `world.getState` なども含む。
  - 代わりの書き方がまだないものは「追加予定」と書く。`world.spawn`・`world.destroy` の代わりは、`Prefab.spawn`・`Prefab.destroy` を作ったときに書き換える。
  - `world.raycast` は、引数に ID を取らないが、結果（`Hit`）が当たった Entity を ID の文字で返すので、付ける（計画者に確認した）。代わりの形は、追加予定。
  - エディタでは、TypeScript の「提案」の診断（`reportsDeprecated`）を使って打ち消し線を引き、理由はコードホバーに出す。問題の一覧には出さない（公式ライブラリと同梱サンプルが多く使っていて、出すと問題だらけに見えるため）。

## 影響

- ADR 0080 の「値の表示と実行の整合」のうち、「続行前には実際の世界へ戻す」をやめた。`e.get()` で書いた値は `world.get()` からすぐ読めるのが正しい動きになったので、戻す理由がなくなった。
- ADR 0019 の `deprecated` の決め方（後継があり、いずれ外す）を、「後継がある、または追加予定で、いずれ外す」に広げる（`@deprecated` を付けるとき）。
- ADR 0076 のプレハブに、パラメータと、実行中に作る道を足す。
