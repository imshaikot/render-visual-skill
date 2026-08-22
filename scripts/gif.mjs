// Pure-Node GIF assembly: decode Chrome's PNG frames with the built-in zlib,
// quantize to a shared 256-color palette, LZW-encode, write GIF89a.
// No ffmpeg, no dependencies — GIF is a 1989 format and small enough to hand-roll.
import { inflateSync } from 'node:zlib'

/* ── PNG decode ─────────────────────────────────────────────────────────── */

/** Decode an 8-bit non-interlaced RGB/RGBA PNG to { width, height, rgb } (rgb = Buffer, 3 bytes/px). */
export function decodePng(buf) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG')

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, color type ${colorType}, interlace ${interlace})`)
  }

  const bpp = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const rgb = Buffer.allocUnsafe(width * height * 3)
  const prev = Buffer.alloc(stride)
  const line = Buffer.allocUnsafe(stride)

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    const filter = raw[rowStart]
    raw.copy(line, 0, rowStart + 1, rowStart + 1 + stride)

    // Unfilter in place: 0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth.
    if (filter === 1) {
      for (let i = bpp; i < stride; i++) line[i] = (line[i] + line[i - bpp]) & 255
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 255
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? line[i - bpp] : 0
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0
        const b = prev[i]
        const c = i >= bpp ? prev[i - bpp] : 0
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        line[i] = (line[i] + pred) & 255
      }
    } else if (filter !== 0) {
      throw new Error(`bad PNG filter ${filter}`)
    }

    line.copy(prev)
    for (let x = 0; x < width; x++) {
      const s = x * bpp, d = (y * width + x) * 3
      rgb[d] = line[s]
      rgb[d + 1] = line[s + 1]
      rgb[d + 2] = line[s + 2]
    }
  }
  return { width, height, rgb }
}

/* ── Quantization: median cut over the exact color histogram ────────────── */

function buildPalette(src, maxColors = 256) {
  const hist = new Map() // rgb24 -> count
  for (let f = 0; f < src.count; f++) {
    const { rgb } = src.get(f)
    for (let i = 0; i < rgb.length; i += 3) {
      const key = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2]
      hist.set(key, (hist.get(key) || 0) + 1)
    }
  }

  let colors = [...hist.entries()].map(([key, count]) => ({
    r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255, count, key,
  }))

  let boxes = [colors]
  while (boxes.length < maxColors) {
    // Split the box with the widest channel range (weighted toward populous boxes).
    let bi = -1, best = 0
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.length < 2) continue
      let rmin = 256, rmax = -1, gmin = 256, gmax = -1, bmin = 256, bmax = -1
      for (const c of box) {
        if (c.r < rmin) rmin = c.r; if (c.r > rmax) rmax = c.r
        if (c.g < gmin) gmin = c.g; if (c.g > gmax) gmax = c.g
        if (c.b < bmin) bmin = c.b; if (c.b > bmax) bmax = c.b
      }
      const range = Math.max(rmax - rmin, gmax - gmin, bmax - bmin)
      if (range > best) { best = range; bi = i; box.widest = rmax - rmin >= gmax - gmin && rmax - rmin >= bmax - bmin ? 'r' : gmax - gmin >= bmax - bmin ? 'g' : 'b' }
    }
    if (bi < 0) break

    const box = boxes[bi]
    const ch = box.widest
    box.sort((a, b) => a[ch] - b[ch])
    const total = box.reduce((sum, c) => sum + c.count, 0)
    let acc = 0, cut = 1
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].count
      if (acc >= total / 2) { cut = i + 1; break }
    }
    boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut))
  }

  const palette = boxes.map((box) => {
    let r = 0, g = 0, b = 0, n = 0
    for (const c of box) { r += c.r * c.count; g += c.g * c.count; b += c.b * c.count; n += c.count }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
  })

  // Exact index for every color that occurs, via nearest palette entry.
  const index = new Map()
  for (const c of colors) {
    let bestI = 0, bestD = Infinity
    for (let i = 0; i < palette.length; i++) {
      const dr = c.r - palette[i][0], dg = c.g - palette[i][1], db = c.b - palette[i][2]
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) { bestD = d; bestI = i }
    }
    index.set(c.key, bestI)
  }
  return { palette, index }
}

/* ── GIF-flavored LZW ───────────────────────────────────────────────────── */

function lzwEncode(indexed, minCodeSize) {
  const CLEAR = 1 << minCodeSize
  const EOI = CLEAR + 1
  const bytes = []
  let cur = 0, curBits = 0

  const emit = (code, size) => {
    cur |= code << curBits
    curBits += size
    while (curBits >= 8) { bytes.push(cur & 255); cur >>= 8; curBits -= 8 }
  }

  let codeSize = minCodeSize + 1
  let dict = new Map()
  let nextCode = EOI + 1

  // The decoder's table lags the encoder's by one entry, so the width grows AFTER
  // a code is emitted at the old width, never immediately after an entry is added.
  const emitData = (code) => {
    emit(code, codeSize)
    if (nextCode >= 1 << codeSize && codeSize < 12) codeSize++
  }

  emit(CLEAR, codeSize)
  let prefix = indexed[0]
  for (let i = 1; i < indexed.length; i++) {
    const k = indexed[i]
    const key = prefix * 256 + k
    const found = dict.get(key)
    if (found !== undefined) {
      prefix = found
    } else {
      emitData(prefix)
      if (nextCode < 4096) {
        dict.set(key, nextCode++)
      } else {
        emit(CLEAR, codeSize)
        dict = new Map()
        codeSize = minCodeSize + 1
        nextCode = EOI + 1
      }
      prefix = k
    }
  }
  emitData(prefix)
  emit(EOI, codeSize)
  if (curBits > 0) bytes.push(cur & 255)
  return Buffer.from(bytes)
}

/* ── GIF89a writer ──────────────────────────────────────────────────────── */

// Ordered 4x4 dither while mapping: breaks up the banding that 256 colors
// would otherwise print across the themes' soft glows. Deterministic per (x, y),
// so a pixel whose RGB did not change maps to the same index every frame —
// which is what makes the delta encoding below effective.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

function quantizeFrame(frame, palette, index, cache) {
  const { width, height, rgb } = frame
  const indexed = new Uint8Array(width * height)
  for (let y = 0, p = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p++, i += 3) {
      const t = Math.round((BAYER[((y & 3) << 2) | (x & 3)] / 16 - 0.5) * 10)
      const r = Math.min(255, Math.max(0, rgb[i] + t))
      const g = Math.min(255, Math.max(0, rgb[i + 1] + t))
      const b = Math.min(255, Math.max(0, rgb[i + 2] + t))
      const key = (r << 16) | (g << 8) | b
      let idx = index.get(key) ?? cache.get(key)
      if (idx === undefined) {
        let bestI = 0, bestD = Infinity
        for (let j = 0; j < palette.length; j++) {
          const dr = r - palette[j][0], dg = g - palette[j][1], db = b - palette[j][2]
          const d = dr * dr + dg * dg + db * db
          if (d < bestD) { bestD = d; bestI = j }
        }
        cache.set(key, bestI)
        idx = bestI
      }
      indexed[p] = idx
    }
  }
  return indexed
}

/**
 * frames: [{ width, height, rgb }] (all same size), or a lazy provider
 * { count, get(i) } so a long animation never holds every decoded frame in
 * memory at once (get may be called more than once per frame).
 * delays: per-frame ms array. Without it, delayMs per frame with holdMs on the
 * final frame. Loops forever.
 *
 * Frames after the first are stored as deltas: only the bounding box of changed
 * pixels is written, with unchanged pixels inside it transparent (disposal
 * "do not dispose"). At 20+ fps most tween frames touch a few percent of the
 * canvas, so this is what keeps high frame counts affordable.
 */
export function encodeGif(frames, { delayMs = 900, holdMs = 2200, delays } = {}) {
  const src = Array.isArray(frames) ? { count: frames.length, get: (i) => frames[i] } : frames
  const { width, height } = src.get(0)
  const useDelta = src.count > 1
  // Delta frames need one palette slot for "unchanged": cap colors at 255.
  const { palette, index } = buildPalette(src, useDelta ? 255 : 256)
  const transparent = palette.length // first unused slot
  const slots = palette.length + (useDelta ? 1 : 0)

  let sizeExp = 0
  while (1 << (sizeExp + 1) < slots) sizeExp++
  const tableSize = 1 << (sizeExp + 1)
  const minCodeSize = Math.max(2, sizeExp + 1)

  const parts = []
  parts.push(Buffer.from('GIF89a', 'ascii'))

  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(width, 0)
  lsd.writeUInt16LE(height, 2)
  lsd[4] = 0x80 | (7 << 4) | sizeExp // global table, 8-bit color resolution
  parts.push(lsd)

  const table = Buffer.alloc(tableSize * 3)
  palette.forEach(([r, g, b], i) => { table[i * 3] = r; table[i * 3 + 1] = g; table[i * 3 + 2] = b })
  parts.push(table)

  // NETSCAPE2.0: loop forever.
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 3, 1, 0, 0, 0]))

  const cache = new Map() // dithered rgb24 -> palette index, shared across frames
  let prev = null

  for (let fi = 0; fi < src.count; fi++) {
    const frame = src.get(fi)
    const ms = delays ? delays[fi] : fi === src.count - 1 ? holdMs : delayMs
    // Browsers clamp GIF delays below 2cs to 100ms, so 2cs (50fps) is the
    // floor; the GCE delay field is 16-bit, so 65535cs is the ceiling.
    const cs = Math.min(65535, Math.max(src.count > 1 ? 2 : 0, Math.round(ms / 10) || 0))

    const indexed = quantizeFrame(frame, palette, index, cache)

    let x0 = 0, y0 = 0, subW = width, subH = height, sub = indexed, hasTrans = false
    if (prev) {
      let x1 = -1, y1 = -1
      x0 = width; y0 = height
      for (let y = 0; y < height; y++) {
        const row = y * width
        for (let x = 0; x < width; x++) {
          if (indexed[row + x] !== prev[row + x]) {
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
          }
        }
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0 } // identical frame: 1px, keeps the timing
      subW = x1 - x0 + 1
      subH = y1 - y0 + 1
      sub = new Uint8Array(subW * subH)
      for (let y = 0; y < subH; y++) {
        for (let x = 0; x < subW; x++) {
          const p = (y0 + y) * width + (x0 + x)
          sub[y * subW + x] = indexed[p] === prev[p] ? transparent : indexed[p]
        }
      }
      hasTrans = true
    }
    prev = indexed

    // Disposal 1 (do not dispose) composites each delta over the last frame.
    const gce = Buffer.from([0x21, 0xf9, 4, 0x04 | (hasTrans ? 1 : 0), cs & 255, (cs >> 8) & 255, hasTrans ? transparent : 0, 0])
    parts.push(gce)

    const desc = Buffer.alloc(10)
    desc[0] = 0x2c
    desc.writeUInt16LE(x0, 1)
    desc.writeUInt16LE(y0, 3)
    desc.writeUInt16LE(subW, 5)
    desc.writeUInt16LE(subH, 7)
    parts.push(desc)

    parts.push(Buffer.from([minCodeSize]))
    const lzw = lzwEncode(sub, minCodeSize)
    for (let off = 0; off < lzw.length; off += 255) {
      const chunk = lzw.subarray(off, off + 255)
      parts.push(Buffer.from([chunk.length]), chunk)
    }
    parts.push(Buffer.from([0]))
  }

  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}
