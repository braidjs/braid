import { tagClass } from './tags.js';

/**
 * A tag, colored by {@link tagClass}. With `onSelect` it is a button — clicking a tag filters by
 * it — and otherwise plain text, so a list of tags never becomes a row of dead controls.
 */
export function TagChip({ tag, onSelect }: { tag: string; onSelect?: (tag: string) => void }) {
  if (!onSelect) return <span className={tagClass(tag)}>{tag}</span>;
  return (
    <button type="button" className={`${tagClass(tag)} braid-console__tagbutton`} onClick={() => onSelect(tag)} aria-label={`Filter by tag ${tag}`}>
      {tag}
    </button>
  );
}
