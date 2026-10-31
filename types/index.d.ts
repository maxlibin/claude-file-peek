/** One row of the picker: a file or folder of the open folder, hidden ones left out. */
export type Entry = { name: string; isDir: boolean }

/** The picker's open folder (absolute, ending in `/`), its rows, and the row the ring is on. */
export type Picker = { folder: string; entries: Entry[]; highlighted: string | null }

/** What the info panel shows for the highlighted row. */
export type Info = {
  /** The row it describes, so a stale description is never drawn beside another row. */
  entry: string
  /** Summary lines: kind, size and date, dimensions or pages, git state. */
  lines: string[]
  /** The first lines of a text file; empty for anything else. */
  preview: string[]
  /** An image's thumbnail as rows of quadrant-glyph cells; null for anything else. */
  thumbnail: ThumbnailCell[][] | null
}

/** One terminal cell of a thumbnail: a quadrant glyph drawn in `fg` over `bg`, both `#rrggbb`. */
export type ThumbnailCell = { glyph: string; fg: string; bg: string }

declare module 'claude-code' {
  interface PluginState {
    'file-peek': { picker: Picker | null; info: Shaped<Info | null>; isHinted: boolean }
  }
}
