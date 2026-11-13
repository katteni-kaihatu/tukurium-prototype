import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { useApp } from "./app/store";
import { type AuthState, fetchAuth } from "./auth/auth";
import { LoginPage } from "./auth/LoginPage";
import "./styles/global.css";

/** ログインを確かめてからアプリを出す（ADR 0074）。ログインしていなければログインの画面だけを出す */
function Root() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(() => {
    fetchAuth()
      .then((next) => {
        if (next.user) {
          // 名前は接続より先に入れておく（セッション名の初期値などに使う）
          useApp.setState({ me: next.user, myName: next.user.name });
          useApp.getState().client.start();
        }
        setAuth(next);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(check, [check]);
  if (error) return <p style={{ padding: 24 }}>{error}</p>;
  if (!auth) return null;
  if (!auth.user) return <LoginPage auth={auth} onLoggedIn={check} />;
  return <App />;
}

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
