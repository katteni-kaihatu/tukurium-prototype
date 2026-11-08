import { useId, useState } from "react";
import { Header } from "../app/Header";
import { useApp } from "../app/store";
import { api } from "../net/api";
import { useProjectNavigate } from "./ProjectNavigation";
import styles from "./pages.module.css";

const TEMPLATES = [
  { id: "empty", label: "空", desc: "何もないところから" },
  { id: "sample", label: "銃と的", desc: "撃って当てるサンプル" },
  { id: "gun", label: "銃", desc: "銃だけ" },
  { id: "range", label: "射撃場", desc: "的と支柱" },
  { id: "forest", label: "森", desc: "静かな森のワールド" },
  { id: "marubatsu", label: "マルバツ", desc: "二人で○×。E で最初から" },
] as const;

/** リポジトリ（画面上は「プロジェクト」）の新規作成 */
export function NewRepoPage({ embedded = false }: { embedded?: boolean }) {
  const me = useApp((s) => s.me);
  const navigate = useProjectNavigate();
  const ids = { name: useId(), desc: useId() };
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"item" | "world">("item");
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]["id"]>("empty");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const repo = await api.createRepo({
        name: name.trim(),
        description,
        kind,
        template,
        visibility,
      });
      navigate(`/p/${repo.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? styles.embedded : styles.page}>
      {!embedded && <Header />}
      <main className={embedded ? styles.embeddedMain : styles.main} style={{ maxWidth: 760 }}>
        <section className={styles.card} aria-labelledby="new-title">
          <h1 id="new-title" className={styles.title}>
            新しいプロジェクト
          </h1>
          <p className={styles.sub}>
            プロジェクト（リポジトリ）には、ワールドや部品の中身と、そのコミット履歴がすべて入ります。
          </p>
          <div className={styles.row}>
            <span className={styles.badge}>Owner: {me?.name ?? "…"}</span>
            <span>/</span>
          </div>
          <div className={styles.field}>
            <label htmlFor={ids.name}>名前 *</label>
            <input
              id={ids.name}
              className={styles.input}
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={ids.desc}>説明（任意）</label>
            <input
              id={ids.desc}
              className={styles.input}
              value={description}
              maxLength={300}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <fieldset className={styles.field} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className={styles.label}>Kind *</legend>
            <div className={styles.choices}>
              {(["item", "world"] as const).map((k) => (
                <label key={k} className={styles.choice}>
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  <span>
                    {k === "item" ? "アイテム" : "ワールド"}
                    <small>{k === "item" ? "持ち運んで使う部品" : "セッションの空間"}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.field} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className={styles.label}>はじめ方</legend>
            <div className={styles.choices}>
              {TEMPLATES.map((t) => (
                <label key={t.id} className={styles.choice}>
                  <input
                    type="radio"
                    name="template"
                    checked={template === t.id}
                    onChange={() => {
                      setTemplate(t.id);
                      if (t.id === "forest") setKind("world");
                      else if (t.id === "marubatsu") setKind("item");
                    }}
                  />
                  <span>
                    {t.label}
                    <small>{t.desc}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.field} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className={styles.label}>公開範囲 *</legend>
            <div className={styles.choices}>
              {(["public", "private"] as const).map((v) => (
                <label key={v} className={styles.choice}>
                  <input
                    type="radio"
                    name="visibility"
                    checked={visibility === v}
                    onChange={() => setVisibility(v)}
                  />
                  <span>
                    {v === "public" ? "Public" : "Private"}
                    <small>
                      {v === "public"
                        ? "誰でも見られ、フォーク・抽出できる"
                        : "自分だけ（リリースの権限で個別に許可）"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className={styles.row}>
            <span className={styles.badge} title="初版では見た目だけです">
              Remote: Tukurium（GitHub 連携は準備中）
            </span>
          </div>
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.row}>
            <button type="button" className={styles.btn} onClick={() => navigate(-1)}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={!name.trim() || busy || !me}
              onClick={() => void submit()}
            >
              {busy ? "作成しています…" : "プロジェクトを作成"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
