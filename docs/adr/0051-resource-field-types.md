# ADR 0051：リソースを指す欄の型を、テクスチャ・マテリアル・モデル・音声に分ける

- 状態: 採用・実装済み
- 関連：ADR 0010（論理パス）、ADR 0012（Host API と Capability）

## 理由

KokoState の欄の型「Resource」は、マテリアルも素材（画像・モデル・音声）もまとめて指していた。利用者が作った欄では何を入れる欄か分からず、選ぶ一覧にもすべてが並んだ。Built-in の欄だけは、別の表（`RESOURCE_KIND`）で種類を決めていた。

## 決定

- 欄の型 `resource` をやめ、`texture`（画像の素材）・`material`（マテリアル）・`model`（3D の素材）・`audio`（音声の素材）に分ける。値はどれも ID の文字列か null。
- 何を指すかは型で決まる（`RESOURCE_FIELD_KIND`）。Built-in の Mesh.material は `material`、Mesh.model は `model`、AudioSource.clip は `audio`。`RESOURCE_KIND` の表はなくす。
- Inspector で選ぶ一覧には、その型のものだけを出す。違う種類を指していたら、これまでどおり問題（`wrong-resource-kind`）にする。
- 音声は頼まれた三つに入っていないが、AudioSource.clip のために型を一つ持たせる。
- プロトタイプの保存形式は変えてよいので、`resource` の欄を持つ古い開発用データは移さない。
