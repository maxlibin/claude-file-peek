import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Info, ThumbnailCell } from '../types'

const PANE = 'file-peek'
const picker = atom({ plugin: 'file-peek', key: 'picker' } as const, null)
const info = atom({ plugin: 'file-peek', key: 'info' } as const, null, { shape: 'info-3' })
const isHinted = atom({ plugin: 'file-peek', key: 'isHinted' } as const, false)

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i
// The `@` mention the cursor ends; Claude Code quotes one with spaces, and the
// closing quote is missing while it is still being typed.
const MENTION_AT_CURSOR = /(?:^|\s)@("[^"]*"?|\S*)$/
const PREVIEW_LINES = 8
const MAX_ENTRIES = 500

/** The draft around the mention the picker replaces, put back on close or with the pick. */
type Stash = { before: string; mention: string; after: string }

// Module state: reset by a reload, which also drops the picker's pane.
let cwd = ''
let home = ''
let stash: Stash | null = null
// Bumped per highlight, so a slow description never overwrites a newer one.
let describing = 0
// Temp folder for the small BMPs thumbnails are sampled from, made on first need; each is removed once read.
let thumbnailDir = ''
let thumbnails = 0
// The info panel's room for a thumbnail, in cells, as the picker was last drawn.
let thumbnailColumns = 40
let thumbnailRows = 12

const unquote = (mention: string): string => mention.replace(/^"/, '').replace(/"$/, '')

const expandHome = (path: string): string => (path === '~' || path.startsWith('~/') ? home + path.slice(1) : path)

const absolute = (path: string): string => (path.startsWith('/') ? path : `${cwd}/${path}`)

const tildePath = (path: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

/** The `@` mention text for `path`, quoted when it holds whitespace as Claude Code writes it. */
const mentionFor = (path: string): string => (/\s/.test(path) ? `@"${tildePath(path)}"` : `@${tildePath(path)}`)

/** Runs a command and returns its stdout, raising with the command and stderr when it fails. */
const run = async ($: EngineInterface, argv: readonly string[]): Promise<string> => {
  const { exitCode, stdout, stderr } = await $.process.run(argv)
  if (exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${exitCode}: ${stderr.trim()}`)
  }
  return stdout
}

const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const formatTime = (ms: number, nowMs: number): string => {
  const date = new Date(ms)
  const now = new Date(nowMs)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === now.toDateString()) {
    return `today ${clock}`
  }
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`
  return date.getFullYear() === now.getFullYear() ? `${day} ${clock}` : `${day} ${date.getFullYear()}`
}

/** The git state of `name` in `folder`, or null outside a repository. */
const gitLine = async ($: EngineInterface, folder: string, name: string, isDir: boolean): Promise<string | null> => {
  const inside = await $.process.run(['git', '-C', folder, 'rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0) {
    return null
  }
  const status = await run($, ['git', '-C', folder, 'status', '--porcelain', '--ignored', '--', name])
  const changes = status.split('\n').filter(line => line !== '')
  if (isDir) {
    return changes.length === 0 ? 'git: clean' : `git: ${changes.length} changed`
  }
  const code = changes[0]?.slice(0, 2)
  if (code === undefined) {
    return 'git: committed'
  }
  if (code === '??') {
    return 'git: untracked'
  }
  if (code === '!!') {
    return 'git: ignored'
  }
  const states = [code[0] !== ' ' ? 'staged' : '', code[1] !== ' ' ? 'modified' : ''].filter(state => state !== '')
  return `git: ${states.join(', ')}`
}

/** Reads one `name: value` line of `sips -g` output. */
const sipsField = (stdout: string, name: string, path: string): string => {
  const value = stdout.match(new RegExp(`^\\s*${name}: (.+)$`, 'm'))?.[1]
  if (value === undefined) {
    throw new Error(`sips printed no ${name} for ${path}: ${stdout.trim()}`)
  }
  return value.trim()
}

// `Uint8Array.fromBase64` is in the engine's runtime (ES2026) but not yet in the TypeScript lib this mod compiles against.
const fromBase64 = (base64: string): Uint8Array =>
  (Uint8Array as unknown as { fromBase64: (encoded: string) => Uint8Array }).fromBase64(base64)

type Rgb = readonly [number, number, number]

// Channels are rounded to steps of 8, invisible at this size, so neighbouring cells of a flat area
// share colours and join into one Text.
const hex = ([red, green, blue]: Rgb): string =>
  `#${[red, green, blue]
    .map(channel => Math.min(255, Math.round(channel / 8) * 8).toString(16).padStart(2, '0'))
    .join('')}`

/**
 * Reads the pixels of a 32-bit BITFIELDS BMP, the layout `sips -s format bmp` writes,
 * row by row from the top; transparency is blended onto black.
 */
const decodeBmp = (bytes: Uint8Array, path: string): Rgb[][] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = view.getUint32(10, true)
  const width = view.getInt32(18, true)
  const rawHeight = view.getInt32(22, true)
  const bitsPerPixel = view.getUint16(28, true)
  const compression = view.getUint32(30, true)
  if (bitsPerPixel !== 32 || compression !== 3) {
    throw new Error(`thumbnail of ${path}: expected a 32-bit BITFIELDS BMP from sips, got ${bitsPerPixel} bits, compression ${compression}`)
  }
  const masks = [54, 58, 62, 66].map(at => view.getUint32(at, true))
  const shifts = masks.map(mask => (mask === 0 ? 0 : 31 - Math.clz32(mask & -mask)))
  const channel = (value: number, index: number): number => ((value & (masks[index] ?? 0)) >>> (shifts[index] ?? 0)) & 0xff
  const height = Math.abs(rawHeight)
  return Array.from({ length: height }, (_, y) => {
    // A positive height stores rows bottom-up.
    const row = rawHeight < 0 ? y : height - 1 - y
    return Array.from({ length: width }, (_, x) => {
      const value = view.getUint32(offset + (row * width + x) * 4, true)
      const alpha = masks[3] === 0 ? 255 : channel(value, 3)
      const blend = (index: number): number => (channel(value, index) * alpha) / 255
      return [blend(0), blend(1), blend(2)] as const
    })
  })
}

// Quadrant glyphs by which of a cell's four pixels take the foreground colour:
// bit 8 top-left, 4 top-right, 2 bottom-left, 1 bottom-right.
const QUADRANTS = [' ', '▗', '▖', '▄', '▝', '▐', '▞', '▟', '▘', '▚', '▌', '▙', '▀', '▜', '▛', '█']

const average = (pixels: readonly Rgb[]): Rgb => {
  const sum = pixels.reduce<[number, number, number]>((total, [r, g, b]) => [total[0] + r, total[1] + g, total[2] + b], [0, 0, 0])
  return [sum[0] / pixels.length, sum[1] / pixels.length, sum[2] / pixels.length]
}

const distance = (a: Rgb, b: Rgb): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

/** The quadrant glyph and two colours that best reproduce four pixels (top-left, top-right, bottom-left, bottom-right). */
const quadrantCell = (pixels: readonly [Rgb, Rgb, Rgb, Rgb]): ThumbnailCell => {
  // Masks 8..15 hold the top-left pixel in the foreground, which covers every split once.
  const candidates = [8, 9, 10, 11, 12, 13, 14, 15].map(mask => {
    const inFg = pixels.map((_, index) => (mask & (8 >> index)) !== 0)
    const fg = average(pixels.filter((_, index) => inFg[index]))
    const bgPixels = pixels.filter((_, index) => !inFg[index])
    const bg = bgPixels.length === 0 ? fg : average(bgPixels)
    const error = pixels.reduce((sum, pixel, index) => sum + distance(pixel, inFg[index] ? fg : bg), 0)
    return { mask, fg, bg, error }
  })
  const best = candidates.reduce((a, b) => (b.error < a.error ? b : a))
  return { glyph: QUADRANTS[best.mask] ?? '█', fg: hex(best.fg), bg: hex(best.bg) }
}

/** Scales the image to fit `columns` × `rows` cells of 2×2 pixels each and turns it into quadrant cells. */
const thumbnailCells = async (
  $: EngineInterface,
  path: string,
  width: number,
  height: number,
): Promise<ThumbnailCell[][]> => {
  const columns = thumbnailColumns
  const rows = thumbnailRows
  // A cell is about twice as tall as wide, so its 2×2 pixels are each about 1:2 too: one cell column
  // spans the image width of one cell row's half-height pixel pair.
  const fitsWide = (height * columns) / width <= rows * 2
  const cellsWide = Math.max(1, fitsWide ? columns : Math.round((rows * 2 * width) / height))
  const cellsHigh = Math.max(1, Math.round(fitsWide ? (height * columns) / width / 2 : rows))
  const pixelsWide = cellsWide * 2
  const pixelsHigh = cellsHigh * 2
  if (thumbnailDir === '') {
    thumbnailDir = (await run($, ['mktemp', '-d', '-t', 'file-peek'])).trim()
  }
  thumbnails += 1
  const file = `${thumbnailDir}/${thumbnails}.bmp`
  await run($, ['sips', '-s', 'format', 'bmp', '-z', String(pixelsHigh), String(pixelsWide), path, '--out', file])
  const { base64 } = await $.fs.read(file, { as: 'bytes' })
  await run($, ['rm', file])
  const pixels = decodeBmp(fromBase64(base64), path)
  const at = (x: number, y: number): Rgb => pixels[y]?.[x] ?? [0, 0, 0]
  return Array.from({ length: cellsHigh }, (_, cy) =>
    Array.from({ length: cellsWide }, (_, cx) =>
      quadrantCell([at(cx * 2, cy * 2), at(cx * 2 + 1, cy * 2), at(cx * 2, cy * 2 + 1), at(cx * 2 + 1, cy * 2 + 1)]),
    ),
  )
}

/** Kind-specific lines (dimensions for an image, pages for a PDF, `file`'s description otherwise) and an image's thumbnail. */
const kindLines = async ($: EngineInterface, path: string): Promise<Pick<Info, 'lines' | 'thumbnail'>> => {
  const kind = (await run($, ['file', '-b', path])).trim()
  if (IMAGE_EXTENSION.test(path)) {
    const { stdout } = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', path])
    // sips exits 0 and prints no fields for a file it cannot read as an image.
    if (!/pixelWidth:/.test(stdout)) {
      return { lines: [`${kind} (not readable as an image)`], thumbnail: null }
    }
    const format = sipsField(stdout, 'format', path)
    const width = Number(sipsField(stdout, 'pixelWidth', path))
    const height = Number(sipsField(stdout, 'pixelHeight', path))
    return {
      lines: [`${format.toUpperCase()} image · ${width}×${height}`],
      thumbnail: await thumbnailCells($, path, width, height),
    }
  }
  if (/\.pdf$/i.test(path)) {
    const pages = (await run($, ['mdls', '-raw', '-name', 'kMDItemNumberOfPages', path])).trim()
    return { lines: [pages === '(null)' ? 'PDF document' : `PDF document · ${pages} pages`], thumbnail: null }
  }
  return { lines: [kind], thumbnail: null }
}

/** Line count and first lines of a text file; nothing for a binary one. */
const textPreview = async ($: EngineInterface, path: string): Promise<{ lines: string[]; preview: string[] }> => {
  const encoding = (await run($, ['file', '-b', '--mime-encoding', path])).trim()
  if (encoding === 'binary') {
    return { lines: [], preview: [] }
  }
  const count = (await run($, ['wc', '-l', path])).trim().split(/\s+/)[0] ?? '0'
  const preview = (await run($, ['head', '-n', String(PREVIEW_LINES), path])).split('\n').slice(0, PREVIEW_LINES)
  return { lines: [`${count} lines`], preview }
}

const describeEntry = async ($: EngineInterface, folder: string, entry: Entry): Promise<Info> => {
  const path = folder + entry.name
  const stat = await $.fs.stat(path)
  const modified = formatTime(stat.mtimeMs, await $.clock.now())
  const git = await gitLine($, folder, entry.name, entry.isDir)
  const gitLines = git === null ? [] : [git]
  if (entry.isDir) {
    const count = (await $.fs.list(path)).filter(child => !child.name.startsWith('.')).length
    return {
      entry: entry.name,
      lines: [`Folder · ${count} items`, `modified ${modified}`, ...gitLines],
      preview: [],
      thumbnail: null,
    }
  }
  const text = IMAGE_EXTENSION.test(path) ? { lines: [], preview: [] } : await textPreview($, path)
  const kind = await kindLines($, path)
  return {
    entry: entry.name,
    lines: [...kind.lines, `${formatBytes(stat.size)} · modified ${modified}`, ...text.lines, ...gitLines],
    preview: text.preview,
    thumbnail: kind.thumbnail,
  }
}

/** Puts the ring's row into `picker` and its description into `info`. */
const highlight = async ($: EngineInterface, name: string): Promise<void> => {
  const state = await read($, picker)
  const entry = state?.entries.find(candidate => candidate.name === name)
  if (state === null || entry === undefined) {
    return
  }
  await update($, picker, current => (current === null ? null : { ...current, highlighted: name }))
  describing += 1
  const mine = describing
  const described = await describeEntry($, state.folder, entry)
  if (mine === describing) {
    await update($, info, () => described)
  }
}

/** Lists `folder` (absolute, ending in `/`) into the picker, highlighting the first row starting with `prefix`. */
const openFolder = async ($: EngineInterface, folder: string, prefix: string): Promise<void> => {
  const entries = (await $.fs.list(folder))
    .filter(entry => !entry.name.startsWith('.') && entry.kind !== 'other')
    .map(entry => ({ name: entry.name, isDir: entry.kind === 'dir' }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .slice(0, MAX_ENTRIES)
  const lowered = prefix.toLowerCase()
  const first = entries.find(entry => entry.name.toLowerCase().startsWith(lowered)) ?? entries[0]
  await update($, info, () => null)
  await update($, picker, () => ({ folder, entries, highlighted: first?.name ?? null }))
  if (first !== undefined) {
    await highlight($, first.name)
  }
}

const parentOf = (folder: string): string => {
  const trimmed = folder.replace(/\/$/, '')
  return trimmed === '' ? '/' : trimmed.slice(0, trimmed.lastIndexOf('/') + 1) || '/'
}

/** The folder a typed mention points at and the name prefix typed inside it. */
const resolveMention = async ($: EngineInterface, mention: string): Promise<{ folder: string; prefix: string }> => {
  const typed = unquote(mention)
  const path = typed === '' ? `${cwd}/` : absolute(expandHome(typed))
  if (path.endsWith('/')) {
    return { folder: path, prefix: '' }
  }
  if ((await $.fs.exists(path)) && (await $.fs.stat(path)).kind === 'dir') {
    return { folder: `${path}/`, prefix: '' }
  }
  const cut = path.lastIndexOf('/')
  return { folder: path.slice(0, cut + 1), prefix: path.slice(cut + 1) }
}

/** Opens the picker on what `mention` points at, with the keyboard, once the prompt is empty. */
const openPicker = async ($: EngineInterface, mention: string): Promise<void> => {
  const { folder, prefix } = await resolveMention($, mention)
  if (!(await $.fs.exists(folder))) {
    $.ui.toast(`file-peek: ${tildePath(folder)} does not exist`)
    return
  }
  await openFolder($, folder, prefix)
  const opened = await $.ui.open({ id: PANE, title: 'Pick a file', focus: true, closeOnEscape: true, rows: 18 })
  if (!opened.isPlaced) {
    $.ui.toast(`file-peek could not show the picker: ${opened.reason}`)
  }
}

/** Joins neighbouring thumbnail cells of the same two colours, so a flat area is one Text. */
const runs = (row: readonly ThumbnailCell[]): { text: string; fg: string; bg: string }[] =>
  row.reduce<{ text: string; fg: string; bg: string }[]>((joined, cell) => {
    const last = joined.at(-1)
    return last !== undefined && last.fg === cell.fg && last.bg === cell.bg
      ? [...joined.slice(0, -1), { ...last, text: last.text + cell.glyph }]
      : [...joined, { text: cell.glyph, fg: cell.fg, bg: cell.bg }]
  }, [])

/** Opens the macOS Quick Look window for `path`; the child lives until the window closes. */
const quickLook = ($: EngineInterface, path: string): void => {
  void (async () => {
    for await (const chunk of $.process.spawn({ argv: ['qlmanage', '-p', path] })) {
      if (chunk.stream === 'stderr') {
        $.ui.log(`qlmanage: ${chunk.text}`, { to: 'debug' })
      }
    }
  })()
}

/** Closes the picker and writes `text` into the prompt with the cursor at `cursor`. */
const closeWith = async ($: EngineInterface, text: string, cursor: number): Promise<void> => {
  stash = null
  await $.ui.close({ id: PANE })
  await update($, picker, () => null)
  await update($, info, () => null)
  await $.prompt.fill({ text, cursor })
}

/** Enter on a row: a folder opens, a file goes into the prompt as an `@` mention. */
const choose = async ($: EngineInterface, folder: string, entry: Entry): Promise<void> => {
  if (entry.isDir) {
    await openFolder($, `${folder}${entry.name}/`, '')
    return
  }
  const draft = stash ?? { before: '', mention: '', after: '' }
  const inserted = `${draft.before}${mentionFor(folder + entry.name)} `
  await closeWith($, inserted + draft.after, inserted.length)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const found = await $.env.get('HOME')
    if (found === undefined) {
      throw new Error('HOME is not set, so ~ paths cannot be expanded')
    }
    home = found
    await $.command.register({
      name: 'peek',
      description: 'Pick a file to @ mention, with info and Quick Look for the highlighted one',
    })
    return next(e)
  })

  on('command.run', { command: 'peek' }, async ($, e) => {
    stash = null
    await openPicker($, e.args.trim())
    return { text: '' }
  })

  // `?` typed right after an `@` mention opens the picker on it instead of being typed.
  on('prompt.edit', async ($, e, next) => {
    const mention = e.text.slice(0, e.cursor).match(MENTION_AT_CURSOR)
    const isTrigger = e.inputText === '?' && e.start === e.cursor && e.end === e.cursor && mention !== null
    if (!isTrigger) {
      const result = await next(e)
      const hinted = MENTION_AT_CURSOR.test(result.text.slice(0, result.cursor))
      if (hinted !== (await read($, isHinted))) {
        await update($, isHinted, () => hinted)
      }
      return result
    }
    const typed = mention[1] ?? ''
    stash = { before: e.text.slice(0, e.cursor - typed.length - 1), mention: `@${typed}`, after: e.text.slice(e.cursor) }
    await update($, isHinted, () => false)
    // The pane only takes the keyboard over an empty prompt, so it opens once this edit has emptied it.
    void (async () => {
      await $.clock.sleep(30)
      await openPicker($, typed)
    })()
    return { text: '', cursor: 0 }
  })

  // Esc (or the close mark) puts the draft back as it was.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    const draft = stash
    stash = null
    await update($, picker, () => null)
    await update($, info, () => null)
    if (draft !== null) {
      const restored = `${draft.before}${draft.mention}`
      await $.prompt.fill({ text: restored + draft.after, cursor: restored.length })
    }
    return result
  })

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    const element = e.element
    if (result.deny === undefined && element?.startsWith('entry:')) {
      // Described in the background so the ring moves at once; a failure is shown, not dropped.
      void highlight($, element.slice('entry:'.length)).catch((error: unknown) => {
        $.ui.log(`file-peek: describing ${element} failed: ${String(error)}`, { to: 'debug' })
        $.ui.toast(`file-peek: ${String(error)}`)
      })
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isHinted))) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>type ? to browse with file info and Quick Look</Text>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, picker)
    if (state === null) {
      return <Text dimColor>No folder open.</Text>
    }
    const details = await read($, info)
    const shown = details !== null && details.entry === state.highlighted ? details : null
    const listColumns = Math.max(20, Math.floor(e.props.bodyColumns * 0.45))
    // The next thumbnail fills the info column below its few lines of details, capped at 48×16 cells:
    // one drawing holds 100,000 characters, and a cell of its own colours costs about 80 of them.
    thumbnailColumns = Math.min(48, Math.max(20, e.props.bodyColumns - listColumns - 2))
    thumbnailRows = Math.min(16, Math.max(6, e.props.scroll.bodyRows - 9))
    // Draw a window of rows around the ring, so arrowing past the edge always lands on a drawn row.
    const room = Math.max(5, e.props.scroll.bodyRows - 3)
    const at = Math.max(0, state.entries.findIndex(entry => entry.name === state.highlighted))
    const start = Math.max(0, Math.min(at - Math.floor(room / 2), state.entries.length - room))
    const rows = state.entries.slice(start, start + room)
    const highlightedPath = state.highlighted === null ? null : state.folder + state.highlighted
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-start">
          {tildePath(state.folder)}
        </Text>
        <Box flexDirection="row" columnGap={2}>
          <Box flexDirection="column" width={listColumns}>
            {start > 0 ? <Text dimColor>{`  ↑ ${start} more`}</Text> : null}
            {rows.map(entry => (
              <Button
                key={`entry:${entry.name}`}
                plain
                autoFocus={entry.name === state.highlighted ? true : undefined}
                onPress={() => choose($, state.folder, entry)}
              >
                <Text wrap="truncate-middle">{entry.isDir ? `${entry.name}/` : entry.name}</Text>
              </Button>
            ))}
            {start + room < state.entries.length ? (
              <Text dimColor>{`  ↓ ${state.entries.length - start - room} more`}</Text>
            ) : null}
            {state.entries.length === 0 ? <Text dimColor>Empty folder</Text> : null}
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {shown === null ? (
              <Text dimColor>…</Text>
            ) : (
              <Box flexDirection="column">
                <Text bold wrap="truncate-end">
                  {shown.entry}
                </Text>
                {shown.lines.map(line => (
                  <Text dimColor wrap="truncate-end">
                    {line}
                  </Text>
                ))}
                {shown.thumbnail === null ? null : (
                  <Box flexDirection="column" marginTop={1}>
                    {shown.thumbnail.map(row => (
                      <Box flexDirection="row">
                        {runs(row).map(run => (
                          <Text color={run.fg} backgroundColor={run.bg}>
                            {run.text}
                          </Text>
                        ))}
                      </Box>
                    ))}
                  </Box>
                )}
                {shown.preview.length > 0 ? <Text> </Text> : null}
                {shown.preview.map(line => (
                  <Text wrap="truncate-end">{line === '' ? ' ' : line}</Text>
                ))}
              </Box>
            )}
          </Box>
        </Box>
        <Box flexDirection="row" columnGap={2}>
          <Button
            key="quick-look"
            label="Quick Look"
            hotkey="p"
            onPress={() => (highlightedPath === null ? undefined : quickLook($, highlightedPath))}
          />
          <Button key="up" label="Up a folder" hotkey="u" onPress={() => openFolder($, parentOf(state.folder), '')} />
          <Text dimColor>↑↓ move · ⏎ open folder or @ file · esc close</Text>
        </Box>
      </Box>
    )
  })
}
