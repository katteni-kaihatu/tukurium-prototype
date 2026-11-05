import { createContext, type ReactNode, useContext } from "react";
import { Link, type LinkProps, useNavigate } from "react-router-dom";

/** 同じプロジェクト画面を、URL とメニュー内の両方で使う。 */
export const ProjectNavigation = createContext<((path: string | number) => void) | null>(null);

export function useProjectNavigate() {
  const local = useContext(ProjectNavigation);
  const navigate = useNavigate();
  return (path: string | number) => {
    if (local) local(path);
    else if (typeof path === "number") navigate(path);
    else navigate(path);
  };
}

export function ProjectLink({ children, ...props }: LinkProps & { children: ReactNode }) {
  const local = useContext(ProjectNavigation);
  return (
    <Link
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (
          !local ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        if (typeof props.to === "string") local(props.to);
      }}
    >
      {children}
    </Link>
  );
}
