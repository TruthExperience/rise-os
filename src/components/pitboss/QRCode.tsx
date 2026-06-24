'use client'

import { useEffect, useRef, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface QRCodeProps {
  /** The value to encode — typically the full verification URL */
  value: string
  /** Size in px. Default 200. */
  size?: number
  /** Quiet zone (border) in modules. Default 4. */
  margin?: number
  /** Foreground colour. Default #000000. */
  dark?: string
  /** Background colour. Default #ffffff. */
  light?: string
  /** Optional centre logo URL — renders a white-padded logo in the middle */
  logoSrc?: string
  /** Logo size as fraction of QR size. Default 0.22. */
  logoFraction?: number
  /** Extra class names on the wrapper div. */
  className?: string
  /** Called when the QR canvas has rendered */
  onReady?: () => void
}

// ─── QR encoding (pure TS, no dependencies) ───────────────────────────────────
// Implements QR Code Model 2, byte mode, error correction level M.
// Sufficient for URLs up to ~154 bytes.

const GF = (() => {
  const EXP = new Uint8Array(512)
  const LOG  = new Uint8Array(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x]  = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
  return {
    mul: (a: number, b: number) => a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]],
    div: (a: number, b: number) => a === 0 ? 0 : EXP[(LOG[a] - LOG[b] + 255) % 255],
    EXP, LOG,
  }
})()

function gfPolyMul(p: number[], q: number[]): number[] {
  const r = new Array(p.length + q.length - 1).fill(0)
  for (let i = 0; i < p.length; i++)
    for (let j = 0; j < q.length; j++)
      r[i + j] ^= GF.mul(p[i], q[j])
  return r
}

function gfPolyDiv(dividend: number[], divisor: number[]): number[] {
  let msg = [...dividend]
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const c = msg[i]
    if (c === 0) continue
    for (let j = 1; j < divisor.length; j++)
      if (divisor[j] !== 0) msg[i + j] ^= GF.mul(divisor[j], c)
  }
  return msg.slice(-(divisor.length - 1))
}

function rsGenerator(n: number): number[] {
  let g = [1]
  for (let i = 0; i < n; i++) g = gfPolyMul(g, [1, GF.EXP[i]])
  return g
}

// Version/EC table for byte mode, EC level M
// [version, totalCodewords, dataCodewords, ecCodewordsPerBlock, blocks]
const VERSION_TABLE: [number, number, number, number, number][] = [
  [1,  26,  16,  10, 1],
  [2,  44,  28,  16, 1],
  [3,  70,  44,  26, 1],
  [4,  100, 64,  18, 2],
  [5,  134, 86,  24, 2],
  [6,  172, 108, 16, 4],
  [7,  196, 124, 18, 4],
  [8,  242, 154, 22, 4],
  [9,  292, 182, 22, 5],
  [10, 346, 216, 26, 5],
]

function pickVersion(byteLen: number) {
  for (const v of VERSION_TABLE) if (v[2] >= byteLen + 4) return v  // +4 for mode+length indicator
  throw new Error(`Data too long for supported versions (max ~212 bytes)`)
}

function encode(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text))
  const [version, , dataCodewords, ecPerBlock, blocks] = pickVersion(bytes.length)
  const size = version * 4 + 17

  // ── Build data bitstream ─────────────────────────────────────────────────
  const bits: number[] = []
  const push = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1) }

  push(0b0100, 4)                      // byte mode
  push(bytes.length, version < 10 ? 8 : 16) // character count
  bytes.forEach(b => push(b, 8))       // data
  push(0, Math.min(4, dataCodewords * 8 - bits.length)) // terminator

  while (bits.length % 8) bits.push(0)

  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    codewords.push(b)
  }
  const padBytes = [0xEC, 0x11]
  while (codewords.length < dataCodewords) codewords.push(padBytes[(codewords.length - bits.length / 8) % 2])

  // ── Reed-Solomon ────────────────────────────────────────────────────────
  const blockSize  = Math.floor(dataCodewords / blocks)
  const gen        = rsGenerator(ecPerBlock)
  const allData: number[][] = []
  const allEc:   number[][] = []

  for (let b = 0; b < blocks; b++) {
    const start = b * blockSize
    const end   = b === blocks - 1 ? dataCodewords : start + blockSize
    const block = codewords.slice(start, end)
    allData.push(block)
    allEc.push(gfPolyDiv([...block, ...new Array(ecPerBlock).fill(0)], gen))
  }

  const interleaved: number[] = []
  const maxLen = Math.max(...allData.map(d => d.length))
  for (let i = 0; i < maxLen; i++) allData.forEach(d => { if (i < d.length) interleaved.push(d[i]) })
  for (let i = 0; i < ecPerBlock; i++) allEc.forEach(e => interleaved.push(e[i]))
  interleaved.push(0) // remainder bits placeholder

  // ── Build module grid ────────────────────────────────────────────────────
  const grid    = Array.from({ length: size }, () => new Array(size).fill(-1)) // -1 = unset
  const isFunc  = Array.from({ length: size }, () => new Array(size).fill(false))

  function setModule(r: number, c: number, dark: boolean, fn = true) {
    grid[r][c]   = dark ? 1 : 0
    isFunc[r][c] = fn
  }

  // Finder patterns
  function addFinder(row: number, col: number) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      if (row + r < 0 || row + r >= size || col + c < 0 || col + c >= size) continue
      const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6))
                || (c >= 0 && c <= 6 && (r === 0 || r === 6))
                || (r >= 2 && r <= 4 && c >= 2 && c <= 4)
      setModule(row + r, col + c, dark)
    }
  }
  addFinder(0, 0); addFinder(0, size - 7); addFinder(size - 7, 0)

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0)
    setModule(i, 6, i % 2 === 0)
  }

  // Dark module
  setModule(size - 8, 8, true)

  // Alignment patterns (version >= 2)
  const alignPos: Record<number, number[]> = {
    2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30], 6:[6,34],
    7:[6,22,38], 8:[6,24,42], 9:[6,26,46], 10:[6,28,50],
  }
  const ap = alignPos[version] ?? []
  for (const r of ap) for (const c of ap) {
    if (isFunc[r][c]) continue
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      setModule(r + dr, c + dc, Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0))
  }

  // Format info placeholders
  const formatPositions = [
    [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
    [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8],
    [size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],
    [8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1],
  ]
  formatPositions.forEach(([r, c]) => setModule(r, c, false))

  // ── Place data bits ──────────────────────────────────────────────────────
  const dataBits: number[] = []
  interleaved.forEach(cw => { for (let i = 7; i >= 0; i--) dataBits.push((cw >> i) & 1) })

  let bitIdx = 0
  let goUp = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      const row = goUp ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const col = right - j
        if (!isFunc[row][col]) {
          setModule(row, col, bitIdx < dataBits.length ? dataBits[bitIdx] === 1 : false, false)
          bitIdx++
        }
      }
    }
    goUp = !goUp
  }

  // ── Masking (pattern 0: (row+col) % 2 === 0) ────────────────────────────
  // Using mask 0 for simplicity; a full implementation evaluates all 8
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (!isFunc[r][c] && (r + c) % 2 === 0) grid[r][c] ^= 1
  }

  // ── Format information (EC level M = 00, mask 0 = 000, pattern 101010000010010) ──
  const formatBits = [1,0,1,0,1,0,0,0,0,0,1,0,0,1,0]
  const fp = formatPositions.slice(0, 15)
  fp.forEach(([r, c], i) => setModule(r, c, formatBits[i] === 1))

  return grid.map(row => row.map(cell => cell === 1))
}

// ─── Canvas renderer ──────────────────────────────────────────────────────────

function drawQR(
  canvas: HTMLCanvasElement,
  modules: boolean[][],
  opts: { size: number; margin: number; dark: string; light: string; logoSrc?: string; logoFraction: number },
  onReady?: () => void,
) {
  const { size, margin, dark, light, logoSrc, logoFraction } = opts
  const count   = modules.length
  const moduleSize = size / (count + margin * 2)
  const offset  = margin * moduleSize

  canvas.width  = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = light
  ctx.fillRect(0, 0, size, size)

  ctx.fillStyle = dark
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (modules[r][c]) {
        ctx.fillRect(
          Math.floor(offset + c * moduleSize),
          Math.floor(offset + r * moduleSize),
          Math.ceil(moduleSize),
          Math.ceil(moduleSize),
        )
      }
    }
  }

  if (!logoSrc) { onReady?.(); return }

  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    const logoSize = size * logoFraction
    const pad      = logoSize * 0.15
    const x        = (size - logoSize) / 2
    const y        = (size - logoSize) / 2

    ctx.fillStyle = light
    ctx.beginPath()
    ctx.roundRect(x - pad, y - pad, logoSize + pad * 2, logoSize + pad * 2, pad * 0.5)
    ctx.fill()

    ctx.drawImage(img, x, y, logoSize, logoSize)
    onReady?.()
  }
  img.onerror = () => onReady?.()
  img.src = logoSrc
}

// ─── Component ────────────────────────────────────────────────────────────────

export function QRCode({
  value,
  size        = 200,
  margin      = 4,
  dark        = '#000000',
  light       = '#ffffff',
  logoSrc,
  logoFraction = 0.22,
  className   = '',
  onReady,
}: QRCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError]     = useState<string | null>(null)
  const [rendered, setRendered] = useState(false)

  useEffect(() => {
    if (!canvasRef.current || !value) return
    setError(null)
    setRendered(false)

    try {
      const modules = encode(value)
      drawQR(
        canvasRef.current,
        modules,
        { size, margin, dark, light, logoSrc, logoFraction },
        () => { setRendered(true); onReady?.() },
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }, [value, size, margin, dark, light, logoSrc, logoFraction, onReady])

  if (error) {
    return (
      <div
        className={`flex items-center justify-center rounded border border-red-200 bg-red-50 text-xs text-red-600 ${className}`}
        style={{ width: size, height: size }}
      >
        QR error
      </div>
    )
  }

  return (
    <div className={`relative inline-block ${className}`} style={{ width: size, height: size }}>
      <canvas
        ref={canvasRef}
        className="block"
        style={{ imageRendering: 'pixelated' }}
        aria-label={`QR code for ${value}`}
        role="img"
      />
      {!rendered && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50 rounded">
          <span className="text-xs text-gray-400">Generating…</span>
        </div>
      )}
    </div>
  )
}

// ─── Download helper (call from a button onClick) ─────────────────────────────

export function downloadQR(
  value: string,
  filename = 'licence-qr.png',
  size     = 600,
) {
  const canvas = document.createElement('canvas')
  try {
    const modules = encode(value)
    drawQR(canvas, modules, { size, margin: 4, dark: '#000000', light: '#ffffff', logoFraction: 0.22 }, () => {
      const a = document.createElement('a')
      a.href     = canvas.toDataURL('image/png')
      a.download = filename
      a.click()
    })
  } catch (e) {
    console.error('QR download failed:', e)
  }
}

export default QRCode
