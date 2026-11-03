# Tukurium プロトタイプ：開発の約束

ブラウザの 3D 空間で、複数人がアイテムやワールドを作るプロトタイプ。要件は `docs/requirements-v0.1.md`、計画と進み具合は `docs/PLAN.md`、決めたことの記録は `docs/adr/`。

## 進め方

- 返信・コメント・UI の文言は日本語で書く。漢語を避けた平易な言い方にする（例：「適用」「出す」「戻す」）。
- 不明な点や判断が必要な点は、推測で決めずに利用者に聞く。設計を決めたら ADR に残す。
- 変更を確かめる手順は `verify-change` スキル、PR を出してマージするまでの手順は `ship-milestone` スキルにまとめてある。
- 詰まりやすい点とその理由は [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) にある。同じ所で詰まったら、そこに書き足す。

## コマンド

| やること | コマンド |
| --- | --- |
| 開発サーバー（client :5173 / server :8787） | `pnpm dev` |
| 整形 → lint（Biome と Dockerfile の検査） | `pnpm format && pnpm lint` |
| 型・単体テスト | `pnpm typecheck` / `pnpm test` |
| ブラウザでの通しテスト（開発サーバーを自動で起動） | `pnpm e2e`。1 本だけなら `pnpm e2e e2e/<name>.spec.ts` |
| 本番ビルドの動作確認 | `pnpm build` のあと `CLIENT_DIR=apps/client/dist node apps/server/dist/main.js` を起動して `pnpm smoke http://localhost:8787` |
| 計測 | `pnpm bench:sim` / `pnpm bench:server <ws URL>` |

## 守ること（破ると壊れる・検査で落ちる）

- **通信の形**は `packages/shared/src/protocol.ts` の zod で決める。互換性がなくなる変更では `PROTOCOL_VERSION` を上げる。
- **パッケージを足したら**、`docker/Dockerfile` に、その package.json の COPY を足す（`pnpm lint` が検査する）。
- **サーバーが実行時に使う npm パッケージ**は `apps/server/package.json` の dependencies に書く。バンドルでは外部扱いになり、本番では node_modules から読む。
- **E2E の `test`** は `e2e/helpers.ts` から import する（Biome で強制）。2 人目以降の参加者は `newPerson()` で開くと、テストの終わりに自動で閉じられる。
- React のフックは、早期 return より前で呼ぶ（Biome の `useHookAtTopLevel`）。
- `window.__workspace` などのデバッグ用の入口は開発ビルドだけにある。E2E や確認用のスクリプトはこれに頼ってよいが、本番向けのスモークテスト（`scripts/smoke.mjs`）では使わない。
- コミットメッセージや PR に、モデルの名前や ID を書かない。
