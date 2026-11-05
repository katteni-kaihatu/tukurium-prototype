import { create } from "zustand";
import type { OwnedItem } from "../net/api";

export interface ItemLabels {
  favorite: boolean;
}
export type ShelfSort = "newest" | "name" | "author";
type ShelfLayout = "grid" | "list";
type ShelfFilter = "all" | "favorites";
interface ShelfPreferences {
  labels: Record<string, ItemLabels>;
  sort: ShelfSort;
  layout: ShelfLayout;
}
interface ItemShelf extends ShelfPreferences {
  owner: string | null;
  filter: ShelfFilter;
  tags: string[];
  availableOnly: boolean;
  storageError: boolean;
  load(owner: string | null): void;
  toggleFavorite(id: string): void;
  toggleTag(tag: string): void;
  setSort(sort: ShelfSort): void;
  setLayout(layout: ShelfLayout): void;
  clearFilters(): void;
}

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
const key = (owner: string) => `tukurium.item-shelf.v1:${owner}`;
const empty = (): ShelfPreferences => ({ labels: {}, sort: "newest", layout: "grid" });

function read(owner: string): ShelfPreferences {
  const raw = localStorage.getItem(key(owner));
  if (!raw) return empty();
  const value = JSON.parse(raw) as Partial<ShelfPreferences>;
  const labels: Record<string, ItemLabels> = {};
  if (value.labels && typeof value.labels === "object") {
    for (const [id, label] of Object.entries(value.labels)) {
      if (!label || typeof label !== "object") continue;
      labels[id] = {
        favorite: label.favorite === true,
      };
    }
  }
  return {
    labels,
    sort: value.sort === "name" || value.sort === "author" ? value.sort : "newest",
    layout: value.layout === "list" ? "list" : "grid",
  };
}

/** お気に入りと表示方法だけをブラウザに保存する。公開タグは作品から読む。 */
export const useItemShelf = create<ItemShelf>((set, get) => {
  const save = (patch: Partial<ShelfPreferences>) => {
    const state = get();
    if (!state.owner) return;
    const next = { labels: state.labels, sort: state.sort, layout: state.layout, ...patch };
    let storageError = false;
    try {
      localStorage.setItem(key(state.owner), JSON.stringify(next));
    } catch {
      storageError = true;
    }
    set({ ...next, storageError });
  };
  const labelFor = (id: string) => get().labels[id] ?? { favorite: false };
  return {
    ...empty(),
    owner: null,
    filter: "all",
    tags: [],
    availableOnly: false,
    storageError: false,
    load: (owner) => {
      if (owner === get().owner) return;
      let preferences = empty();
      let storageError = false;
      if (owner) {
        try {
          preferences = read(owner);
        } catch {
          storageError = true;
        }
      }
      set({ ...preferences, owner, filter: "all", tags: [], availableOnly: false, storageError });
    },
    toggleFavorite: (id) => {
      const label = labelFor(id);
      save({ labels: { ...get().labels, [id]: { ...label, favorite: !label.favorite } } });
    },
    toggleTag: (tag) =>
      set((s) => ({
        tags: s.tags.includes(tag) ? s.tags.filter((t) => t !== tag) : [...s.tags, tag],
      })),
    setSort: (sort) => save({ sort }),
    setLayout: (layout) => save({ layout }),
    clearFilters: () => set({ filter: "all", tags: [], availableOnly: false }),
  };
});

export function shelfItems(
  items: OwnedItem[],
  labels: Record<string, ItemLabels>,
  options: {
    query: string;
    filter: ShelfFilter;
    tags: string[];
    availableOnly: boolean;
    sort: ShelfSort;
  },
) {
  const words = normalize(options.query).trim().split(/\s+/).filter(Boolean);
  const result = items.filter((item) => {
    const label = labels[item.workId];
    const text = normalize(
      `${item.work?.name ?? ""} ${item.work?.ownerName ?? ""} ${item.work?.repoName ?? ""} ${item.work?.tags?.join(" ") ?? ""}`,
    );
    return (
      words.every((word) => text.includes(word)) &&
      (options.filter !== "favorites" || label?.favorite) &&
      (!options.availableOnly || item.available) &&
      options.tags.every((tag) =>
        item.work?.tags?.some((value) => normalize(value) === normalize(tag)),
      )
    );
  });
  const compare = new Intl.Collator("ja", { numeric: true, sensitivity: "base" }).compare;
  return result.sort((a, b) => {
    const compared =
      options.sort === "name"
        ? compare(a.work?.name ?? "", b.work?.name ?? "")
        : options.sort === "author"
          ? compare(a.work?.ownerName ?? "", b.work?.ownerName ?? "")
          : b.acquiredAt.localeCompare(a.acquiredAt);
    return compared || a.workId.localeCompare(b.workId);
  });
}
