# Tukurium プロトタイプ：開発の約束

ブラウザの 3D 空間で、複数人がアイテムやワールドを作るプロトタイプ。文書の入口は `docs/README.md`、できることは `docs/FEATURES.md`、ロードマップは `docs/roadmap/`、決めたことの記録は `docs/adr/`。

## 進め方

- 返信・コメント・UI の文言は日本語で書く。漢語を避けた平易な言い方にする（例：「適用」「出す」「戻す」）。
- 不明な点や判断が必要な点は、推測で決めずに利用者に聞く。設計を決めたら ADR に残す。
- 目指すことは [Tukurium のテーマと原則](docs/PRINCIPLES.md) にある。原則に反しそうな変更や、原則そのものを変える変更は、利用者に確認する。
- 新しい言葉を使い始めたときや、言葉の意味・呼び方を変えたときは、[用語](docs/GLOSSARY.md)を直す。
- 変更を確かめる手順は `verify-change` スキル、PR を出してマージするまでの手順は `ship-milestone` スキルにまとめてある。
- 詰まりやすい点とその理由は [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) にある。同じ所で詰まったら、そこに書き足す。

## コマンド

| やること | コマンド |
| --- | --- |
| 開発サーバー（client :5173 / server :8787） | `pnpm dev` |
| 整形 → lint（Biome と、Dockerfile・ファイル名の検査） | `pnpm format && pnpm lint` |
| 型・単体テスト | `pnpm typecheck` / `pnpm test` |
| ブラウザでの通しテスト（背骨の 4 本、2 分ほど。開発サーバーを自動で起動） | `pnpm e2e` |
| 本番ビルドの動作確認 | `pnpm build` のあと `CLIENT_DIR=apps/client/dist node apps/server/dist/main.js` を起動して `pnpm smoke http://localhost:8787` |
| 計測 | `pnpm bench:sim` / `pnpm bench:server <ws URL>` |

## テストの方針（プロトタイプの間）

- PR の合否を決めるのは lint・型・単体テスト・ビルド（CI の `check`）だけ。ロジック（制作データ・ランタイム・サーバー）は単体テストで守る。
- Markdown、`docs/`、`.claude/`だけの変更では通常CIを実行しない。`main`のE2Eも、これらと通常CI設定だけの変更では実行しない。コード、依存関係、ビルド・実行・E2E設定に触れた場合は省略しない。
- E2E は「背骨」の 4 本だけ：一人で作って撃つ（m1）、2 人で編集・再生（m2）、セッションに出して適用（m3）、3 人で一周（m6）。PR では実行せず、`main` へのマージ後・毎日の定期実行・手動実行で状態と失敗ログを確認する。
- `main` の E2E が落ちても、後続 PR の作成・マージは止めない。テスト名と失敗箇所を残課題に記録し、E2E の確認・修正を別の作業として行う。
- 機能ごとの細かい E2E は足さない。画面の変更は、`verify-change` スキルの手順（使い捨てのスクリプトでスクリーンショット）で確かめる。
- 背骨の流れを変えたときだけ、該当する E2E を直す。

## 守ること（破ると壊れる・検査で落ちる）

- **プロトタイプの保存形式は変更してよい**。既存データの移行や旧形式との互換性維持より、実装の単純さを優先する。必要なら開発用データを破棄し、作り直す。
- **Host API（`world.*` など）を足したら**、`packages/runtime/src/hostApiSpec.ts` の `HOST_API_SPEC` に一件足す（引数・Capability・判定の場所・拒んだときの値・利用者向けの型と説明）。repo-model の `HOST_CAPABILITIES` にも同じ Capability を足す（テストが一致を検査する。ADR 0012）。
- **通信の形**は `packages/shared/src/protocol.ts` の zod で決める。互換性がなくなる変更では `PROTOCOL_VERSION` を上げる。
- **パッケージを足したら**、`docker/Dockerfile` に、その package.json の COPY を足す（`pnpm lint` が検査する）。
- **大文字・小文字だけが違う名前のファイル**（`RingMenu.tsx` と `ringMenu.ts` など）を作らない。Windows では import が別のファイルに当たり、型・ビルド・開発サーバーが動かなくなる（`pnpm lint` が検査する）。
- **サーバーが実行時に使う npm パッケージ**は `apps/server/package.json` の dependencies に書く。バンドルでは外部扱いになり、本番では node_modules から読む。
- **E2E の `test`** は `e2e/helpers.ts` から import する（Biome で強制）。2 人目以降の参加者は `newPerson()` で開くと、テストの終わりに自動で閉じられる。
- React のフックは、早期 return より前で呼ぶ（Biome の `useHookAtTopLevel`）。
- `window.__workspace` などのデバッグ用の入口は開発ビルドだけにある。E2E や確認用のスクリプトはこれに頼ってよいが、本番向けのスモークテスト（`scripts/smoke.mjs`）では使わない。
- コミットメッセージや PR に、モデルの名前や ID を書かない。
