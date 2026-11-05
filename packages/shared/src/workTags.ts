import { z } from "zod";

export const MAX_WORK_TAGS = 12;
export const MAX_WORK_TAG_LENGTH = 24;
export const tagKey = (tag: string) => tag.normalize("NFKC").trim().toLocaleLowerCase();

/** 作品の作者が付ける公開タグ。同じ表記の違いは一件にまとめる。 */
export const workTagsSchema = z
  .array(z.string().trim().min(1).max(MAX_WORK_TAG_LENGTH))
  .max(MAX_WORK_TAGS)
  .transform((tags) => [...new Map(tags.map((tag) => [tagKey(tag), tag])).values()]);

export const splitTagDraft = (draft: string) =>
  draft
    .split(/[,、\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
