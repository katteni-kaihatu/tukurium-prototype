import { useNavigate } from "react-router-dom";
import { useApp } from "../app/store";
import { useWorkspace } from "../workspace/store";
import styles from "./MainMenu.module.css";
import { useMainMenu } from "./store";

export function useMenuPageNavigation() {
  const navigate = useNavigate();
  return (path: string) => {
    const { session, me } = useApp.getState();
    if (
      session &&
      !window.confirm(
        session.owner === me?.id
          ? "このページを開くと、現在のセッションから退出します。持ち主が戻らなければセッションは閉じます。移動しますか？"
          : "このページを開くと、現在のセッションから退出します。移動しますか？",
      )
    )
      return;
    useMainMenu.getState().close();
    navigate(path);
  };
}

export function MenuShortcuts() {
  const session = useApp((s) => s.session);
  const go = useMenuPageNavigation();
  const panel = (key: "libraryOpen" | "belongingsOpen" | "bagOpen") => {
    useWorkspace.setState({ [key]: true, panelsHidden: false });
    useMainMenu.getState().close();
  };
  return (
    <div className={styles.shortcuts}>
      <span className={styles.caption}>制作・その他</span>
      {session && (
        <>
          <button
            type="button"
            onClick={() => {
              useWorkspace.setState({ panelsHidden: false });
              useMainMenu.getState().close();
            }}
          >
            制作に戻る
          </button>
          <button type="button" onClick={() => panel("libraryOpen")}>
            ライブラリを開く
          </button>
          <button type="button" onClick={() => panel("belongingsOpen")}>
            ワールドと配置
          </button>
          <button type="button" onClick={() => panel("bagOpen")}>
            バッグを開く
          </button>
        </>
      )}
      <button type="button" onClick={() => go("/u/me")}>
        自分のプロジェクト
      </button>
      <button type="button" onClick={() => go("/explore")}>
        作品・プロジェクトを探す
      </button>
    </div>
  );
}
