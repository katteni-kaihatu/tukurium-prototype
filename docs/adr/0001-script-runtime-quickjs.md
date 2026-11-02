# ADR 0001：利用者スクリプトの実行環境に QuickJS を使う

- 状態：採用（2026-11-02）
- 関連：要件 §4、計画 §2「スクリプト言語：制限付き JavaScript」

## 決めたこと

利用者が書く System スクリプトは JavaScript とし、`quickjs-emscripten`（QuickJS の WASM 版）の VM で動かす。ページの JavaScript とは別の VM であり、公開 API として渡したもの以外（DOM、`fetch`、`window` など）は存在しない。

実装：`packages/script`（`ScriptSandbox`）。

## 技術検証の結果（`packages/script/src/sandbox.test.ts`）

| 確認したこと | 結果 |
| --- | --- |
| ページのグローバルに触れられない | `fetch` / `process` / `window` / `require` はすべて `undefined` |
| 無限ループの停止 | 割り込みハンドラで呼び出しごとの時間制限（既定 20ms）を超えたら中断。停止後も同じ VM を使い続けられる |
| 読み込み時の無限ループ | 同様に停止 |
| 構文エラー | 読み込みエラーとして System ID 付きで返る |
| オブジェクトの大量生成 | QuickJS のメモリ上限で `out of memory` として停止。VM は使い続けられる |
| 配列要素の大量確保 | **QuickJS のメモリ上限が効かない**（下記） |
| 性能 | 500 Entity の `onUpdate` を 1 回の呼び出しで処理して 約 7ms（開発機） |

### メモリ上限の抜け道と対策

このビルドの QuickJS は、配列の要素領域の確保を `setMemoryLimit` の対象として数えない。8MB の上限を設定しても、`a.push(new Array(10000).fill(1))` を繰り返すと 400MB 以上まで増えた。

対策：

- サンドボックスごとに専用の WASM モジュール（`newQuickJSWASMModule()`）を作り、他のサンドボックスとヒープを共有しない。
- 割り込みハンドラで WASM ヒープの大きさを監視し、「作成時の大きさ＋上限」を超えたら中断する。
- WASM のヒープは縮まないため、この理由で止まったサンドボックスは `broken` になる。呼び出し側（ランタイム）はサンドボックスを作り直し、System を読み込み直す。

### 性能について

Entity の値は呼び出しごとに JSON にまとめて VM に渡し、変更後の値を JSON で受け取る（境界をまたぐ回数を System × イベントあたり 1 回にする）。500 Entity で約 7ms は、60fps（1 フレーム 16ms）では System が複数あると厳しい。初版の検証規模（スクリプトで動く Entity が数十〜百程度）では問題ないと見込む。必要になったら次を行う：

- Query 対象の KokoState のうち、その System が触るフィールドだけを渡す。
- 変更のあったフィールドだけを返す。
- 毎フレームではなくイベント駆動の System を推奨する。

## 却下した案

- **Lua（wasmoon / fengari）**：デザインには「Script (Lua)」とあったが、レビューで制限付き JavaScript に決定。
- **ページ上で直接 JavaScript を実行（`new Function`、iframe サンドボックス）**：要件で避けると決まっている。iframe は同期的な API 呼び出しができず、暴走の停止も難しい。

## 残っている課題

- Web Worker に移すか：現状はホストのメインスレッドで動かす（物理やワールドへの同期 API 呼び出しが単純になるため）。時間制限があるので画面が固まることはないが、重い処理でフレーム落ちはありうる。
- TypeScript で書けるようにするか（読み込み前に型を剥がす）。
