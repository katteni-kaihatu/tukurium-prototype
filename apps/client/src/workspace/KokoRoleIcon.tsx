/** KokoState の役割（KOKO_ROLES）ごとのアイコン。Inspector の見出しに出す */
export function KokoRoleIcon({ role, size = 16 }: { role?: string; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (role) {
    case "transform":
      // 四方向の矢印（動かす）
      return (
        <svg {...p} aria-hidden="true">
          <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />
        </svg>
      );
    case "look":
      return (
        <svg {...p} aria-hidden="true">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
          <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
        </svg>
      );
    case "physics":
      return (
        <svg {...p} aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 2.5" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "interaction":
      return (
        <svg {...p} aria-hidden="true">
          <path d="M9 11V5a1.5 1.5 0 0 1 3 0v5M12 10V4a1.5 1.5 0 0 1 3 0v6M15 10V6a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3.7 14a1.5 1.5 0 0 1 2.4-1.8L9 15" />
        </svg>
      );
    case "audio":
      return (
        <svg {...p} aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
        </svg>
      );
    case "text":
      return (
        <svg {...p} aria-hidden="true">
          <path d="M5 6V4h14v2M12 4v16M9 20h6" />
        </svg>
      );
    case "game":
      return (
        <svg {...p} aria-hidden="true">
          <path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" />
        </svg>
      );
    default:
      return (
        <svg {...p} aria-hidden="true">
          <path d="M4 7l8-4 8 4v10l-8 4-8-4z" />
          <path d="M4 7l8 4 8-4M12 11v10" />
        </svg>
      );
  }
}
