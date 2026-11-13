import type { ReactNode } from "react";
import styles from "./MainMenu.module.css";
import type { ToolWindow } from "./store";

// Tonariumのメニューと同じモチーフで、項目を見分けられるようにする。
export type MenuIconName = ToolWindow | "timeline" | "events" | "groups" | "worlds";

const PATHS: Record<MenuIconName, ReactNode> = {
  timeline: (
    <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.6A7.5 7.5 0 1 1 20 11.5zM9 10h6M9 13.5h4" />
  ),
  events: (
    <path d="M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2M3 10h18M8 3v4M16 3v4" />
  ),
  groups: <path d="M5 21V4M5 4h12l-2 4 2 4H5" />,
  worlds: (
    <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  ),
  library: <path d="M3 4h4v16H3zM10 4h4v16h-4zM17 5l3-1 4 15-3 1z" />,
  projects: <path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3" />,
  workspaces: <path d="M14 5l5 5M4 20l4-1L21 6l-5-5L3 14zM3 21h18" />,
  home: <path d="M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6" />,
  status: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </>
  ),
  friends: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M16 14.2a5 5 0 0 1 5.5 5.8" />
    </>
  ),
  sessions: (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="13" width="4" height="6" rx="1.5" />
      <rect x="17" y="13" width="4" height="6" rx="1.5" />
    </>
  ),
  items: <path d="M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10" />,
  market: (
    <path d="M4 9h16v12H4zM3 9l2-6h14l2 6M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 21v-7h6v7" />
  ),
};

export function MenuIcon({ page }: { page: MenuIconName }) {
  return (
    <svg
      className={styles.navIcon}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[page]}
    </svg>
  );
}
