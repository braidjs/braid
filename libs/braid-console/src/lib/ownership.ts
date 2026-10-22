import type { OwnedTags } from '@braidlabs/registry';

/**
 * Whether the caller may change an item with these tags, by the registry's per-tag ownership:
 * they must own one of its tags, and an untagged item needs `*`. `null` means the registry has no
 * tag ownership, so publish rights are all there is.
 *
 * The server decides every request; this only keeps the console from offering what it would
 * refuse.
 */
export function canChange(tags: readonly string[] | undefined, owned: OwnedTags | null | undefined): boolean {
  if (owned == null || owned === '*') return true;
  return (tags ?? []).some((tag) => owned.includes(tag));
}

/**
 * The tags a new item starts with, so a caller who owns only some tags can still edit what they
 * just created — an untagged item would need `*`.
 */
export function startingTags(owned: OwnedTags | null | undefined): string[] | undefined {
  return owned == null || owned === '*' || owned.length === 0 ? undefined : [owned[0]!];
}
