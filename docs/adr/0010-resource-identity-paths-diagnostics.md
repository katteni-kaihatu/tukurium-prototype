# ADR 0010：リソースの同一性・論理パス・参照の結び付け・診断

- 状態：採用
- 関連：ADR 0001（QuickJS）、ADR 0006（適用）、ADR 0009（Resources のフォルダ。§3 の「フォルダは並べ方だけ」を一部置き換える）
- 詳細計画：[`../plans/resource-paths-and-diagnostics.md`](../plans/resource-paths-and-diagnostics.md)

## 背景

System は KokoState を表示名（`query.with: ["Gun"]`、`e.Gun`）で参照している。このため、同じ名前の KokoState を別のフォルダに置けず、名前を変えると参照が切れる。問題の表示も System のエラーだけで、素材の参照切れやフォルダの不整合は Play しても分からない。

制作の規模を増やす前に、「何がそのリソースか」「人がどう書くか」「何が壊れているか」を分けて決める。

## 決定

### 1. 同一性は安定 ID、パスは人向けの書き方

- リソース（KokoState・System・Material・素材・フォルダ）の同一性は、今の安定 ID のまま変えない。名前の変更やフォルダの移動で ID は変わらない。Entity の状態・状態維持マーク・セッション中の引き継ぎは ID で続く。
- **論理パス**は、人がリソースを指すための書き方で、その時点のフォルダ構造から決まる派生データとする。制作データの正本には保存しない。Git のファイル名（ID ベース）とも別物とする。

| 書き方 | 意味 |
| --- | --- |
| `/Combat/States/Gun.koko` | プロジェクトのいちばん上からのパス |
| `./Gun.koko`・`../States/Gun.koko` | System が入っているフォルダからの相対パス |
| `@builtin/Transform.koko` | Built-in の KokoState |

- 拡張子は種類で決まる：KokoState `.koko`、System `.system`、Material `.material`、素材 `.model`・`.image`・`.audio`。フォルダには付けない。

### 2. 名前の規則

- 別のフォルダなら、同じ名前を使ってよい。
- **同じ親の直下では、種類をまたいで名前を一つにする**（`Gun` という KokoState と `Gun` という System は同じフォルダに置けない）。比べるときは Unicode NFC に正規化し、大文字・小文字の違いは同じとみなす。
- `/`・NUL を含む名前、`.`・`..`、`@builtin` で始まる名前は使えない。
- 衝突は、作る・名前を変える・移す・読み込む（マージや古いデータ）のどの経路でも起こりうる。正本の側で一律に拒むのではなく、**全体の診断**で必ず見つける。UI の操作では、衝突する名前を前もって拒んでよい。

ADR 0009 §3 の「フォルダは並べ方だけで、実行には関わらない」は、この ADR で「フォルダは論理パスを決め、System の相対参照の基準になる」に置き換える。

### 3. System の参照は仮想 import で書き、解決済みの ID で動かす

正式な書き方は仮想 import とする。

```js
import Gun from "../States/Gun.koko";
import TargetGun from "../Targets/Gun.koko";
import Transform from "@builtin/Transform.koko";

export default system({
  query: { with: [Gun, Transform] },
  onUpdate(entity, dt) {
    const gun = entity.get(Gun);
  },
});
```

- import のローカル名が、その System の中での別名になる。同じ名前の KokoState も別名で同時に使える。
- 解析（AST）で import を安定 ID に解決し、QuickJS には ID で動く JS と結び付けの表を渡す。QuickJS が毎フレームパスを探すことはない。
- 一度結び付けた参照は、同じ書き方が後で別の ID を指すようになっても自動で付け替えない（「古い結び付け」の診断を出す）。付け替えるのは、利用者が import を書き換えたときか、ID を基準にした UI のリファクタリングのときだけ。
- import や Query の書き換えに正規表現・文字列置換を使わない。
- `koko("...")` のような関数形式は採らない。表示名での参照（今の書き方）は、移行の間だけ読めるようにする。

### 4. 適用は版ごとの realm で入れ替える

- realm の名前にビルドの版（ワークスペースの版・リリースのコミット）を含める。例：`workspace:<id>:<rev>`、`release:<id>:<commit>`。
- 適用では、同じ版に属する Part と System をまとめて入れ替え、一つの realm に古い版と新しい版の定義を混ぜない。

### 5. 問題（診断）とログを分ける

- **問題**は「今の制作データ、または直前の実行に残っている問題」。同じ問題は指紋（provider・code・対象の ID・安定した位置・関係するリソースの ID）で一行にまとめる。文言や行番号だけを指紋に使わない。
- **ログ**は `log()` などの時系列の記録で、問題とは別に扱う。
- 診断は、どれも保存しない（Y.Doc・ProjectSnapshot・Git に入れない）。作っている途中の問題（authoring）は、各クライアントが同じ Y.Doc から同じ結果を計算する。実行の問題（runtime）はホストの結果を正とし、どの実行のものかを添えて配る。
- 診断の担い手（provider）は種類ごとに分ける：構造（フォルダ・名前・親子）、リソース参照、スクリプト、素材、実行。

### 6. 作っている途中の問題では Play を止めない

エラーがあっても Play できる。問題の一覧に出し、壊れた System は実行時に止まる。試しながら直す使い方を妨げない。

## 結果

- `packages/repo-model` に、論理パスの索引（`ResourcePathIndex`）、汎用の `Diagnostic`、構造の検査（`ProjectStructureValidator`）を置く。どれも UI に依存しない。
- コンパイラ（`compileSystem`）は import 文の範囲だけを `const Gun = __koko("<ID>", "<名前>");` に書き換え、行の数を保つ（source map を使わずに、実行時のエラーの行番号をそのまま使える）。`entity.get(Gun)` で値を取る。
- Phase 5 で runtime を ID ベースにした。`__koko` が返す値は文字列としては KokoState の ID になり、System に渡す状態も「領域の中の KokoState ID」をキーにする。名前が一つに決まる KokoState だけ、移行の間の書き方（`e.Gun`・`with: ["Gun"]`）でも引ける。Registry は同じ名前を許し、名前で引くと曖昧なものは見つからない。別の領域の KokoState は System に見せない。Built-in と同じ名前の KokoState は、移行の間の書き方が曖昧になるので作れない。
- System の書き方と runtime の移行（§3・§4）、Snapshot の版上げは、計画の Phase 4〜7 で行う。それまでは今の表示名での参照が動き続ける。同じ名前の KokoState は、Phase 5 から別のフォルダに作れる。
