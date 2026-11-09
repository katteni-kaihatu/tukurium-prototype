# ADR 0058：スクリプトはすべて TypeScript で書く

- 状態: 採用
- 関連：ADR 0001（QuickJS で実行する）、ADR 0010（リソースの参照と診断。「移行の間は名前で書いた Query も動く」を置き換える）、ADR 0054（AI エージェントの制作）
- ロードマップ：「スクリプトをすべてTypeScriptで書く」。原則 2（入口は低く、奥は深い）・原則 5（安心して作れる）のため

## 背景

System のスクリプトは JavaScript で書いていた。Host API の型の宣言と入力補完はあったが、KokoState の欄には型がなく、欄の名前の打ち間違いや、Query に書いていない KokoState への読み書きは、動かすまで分からなかった。

スクリプトを JavaScript として扱う入口は、ほぼ `compileSystem()`（repo-model）一つに集まっている。実行（ホストのブラウザとサーバーの試し動かし）、編集中の確認、エージェントの確認、依存グラフ、抽出のどれもがここを通る。

## 決定（利用者と決めたこと）

1. **スクリプトはすべて TypeScript で書く。** JavaScript で書けるまま残すことはしない。今あるスクリプトは移さず、TypeScript として扱う（型の誤りが出てよい）。公式のもの（同梱サンプル・公式ライブラリ）は TypeScript に書き直す。
2. **型の判定は厳しくする**（`strict: true` をすべて入れる）。
3. **名前で書いた Query をやめる。** `with: ["Gun"]` のような文字列の Query と、`e.Gun` のような名前での読み書きは、読み込めない問題（エラー）にする。KokoState は import して使う。ADR 0010 の「移行の間は名前で書いた Query も動く」を置き換える。
4. **`e.get()` で触れるのは、その System の Query に書いた KokoState だけにする。** 型の上でも、実行でも同じ決まりにする。
5. **型の誤りがあっても、再生は止めない**（ADR 0010 の「作っている途中の問題では止めない」のまま）。人も AI エージェントも同じように型の誤りを受け取る。
6. **やらないこと**：npm のパッケージや型定義の取り込み、利用者による型チェックの設定（tsconfig）の変更。

## 作り方（設計者が決めたこと）

### 型を消すのと、型を確かめるのを分ける

- **型を消す**：`compileSystem()` の最初で、TypeScript の型を消して JavaScript にする。道具は **sucrase**（`transforms: ["typescript"]`）にする。型を消しても行の数と行の中の位置がほぼ変わらないので、今の「行の数を保つ書き換え」の仕組み（source map を使わない）がそのまま使え、実行時の誤りの行が TypeScript の行になる。軽く速いので、ホストのブラウザでの実行にも、サーバーでも使える。
- **型を確かめる**：**TypeScript 6.0 系**（JavaScript で動く最後の版）の Language Service を使う。リポジトリの開発に使う TypeScript 7（Go で書き直された版）はブラウザでは動かないので、利用者のスクリプトの型の確かめには使わない。
  - 本体は約 9 MB（gzip で約 1.6 MB）ある。ブラウザでは Web Worker で、ワークスペースで型を確かめるときにだけ読み込む。最初の画面が開く速さには影響させない。
  - サーバー（エージェントの確認）では Node でそのまま使う。
  - 型の誤りの文は日本語にする（TypeScript の `locale: "ja"`）。
- 型を確かめる処理は、新しいパッケージ（`packages/typecheck`）にまとめ、ブラウザの Worker とサーバーの両方から使う。制作データと依存の中身を受け取り、型の誤りを `Diagnostic` で返す。

### 型の宣言

- KokoState は、論理パスに合わせた仮想の宣言ファイルにする（例：`/Combat/States/Gun.koko.d.ts`）。`import Gun from "../States/Gun.koko"` を TypeScript がそのまま結び付けられる。Built-in（`@builtin/`）とライブラリ（`@別名/`）も同じように宣言する。
- Host API の宣言（`hostApiDeclarations()`）に、System・Entity・KokoState の型を足す。`system()` に渡す Query から、`e.get()` に渡せる KokoState と、その欄の型を決める。

### 保存の形

- Git には `systems/<ID>.ts` として保存する。読むときは `.js` も受け付ける。

## 確かめたこと

sucrase と TypeScript 6.0.3 で、次を試した。

- 型注釈・interface・型の別名・`as`・`<number>` を含むスクリプトの型を消すと、行の数が変わらない（14 行 → 14 行）。
- Language Service で、仮想の `Gun.koko.d.ts` に `import Gun from "../States/Gun.koko"` が結び付く。欄の名前の打ち間違い（`ammmo`）と、Query にない KokoState を `e.get()` に渡したことが、型の誤りとして出る。一回の確かめは 180 ミリ秒ほど。

## 制約・残課題

- sucrase が扱えない TypeScript の書き方（一部の `namespace` など）は、読み込めない問題になる。
- ブラウザで TypeScript の本体を読み込むので、初めて型を確かめるまで少し時間がかかる。
