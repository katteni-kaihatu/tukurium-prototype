import { useMainMenu } from "./store";

export function useMenuPageNavigation() {
  return (path: string) => useMainMenu.getState().showProject(path);
}
