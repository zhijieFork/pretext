import { layoutNextLine, layoutWithLines, prepareWithSegments, type LayoutCursor, type LayoutLine, type PreparedTextWithSegments } from '../src/layout.ts'
import { BODY_COPY } from './logo-columns-text.ts'
import openaiLogoUrl from './assets/openai-symbol.svg'
import claudeLogoUrl from './assets/claude-symbol.svg'

const BODY_FONT = '16px "Helvetica Neue", Helvetica, Arial, sans-serif'
const BODY_LINE_HEIGHT = 25
const CREDIT_LINE_HEIGHT = 16
const HEADLINE_TEXT = '1 SITUATIONAL AWARENESS: THE DECADE AHEAD'
const HEADLINE_FONT_FAMILY = '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, serif'
const OPENAI_LOGO_SRC = openaiLogoUrl
const CLAUDE_LOGO_SRC = claudeLogoUrl

type Rect = {
  x: number
  y: number
  width: number
  height: number
}

type Interval = {
  left: number
  right: number
}

type Point = {
  x: number
  y: number
}

type LogoKind = 'openai' | 'claude'

type PositionedLine = {
  x: number
  y: number
  text: string
}

type BandObstacle = {
  getIntervals: (bandTop: number, bandBottom: number) => Interval[]
}

type WrapHullMode = 'mean' | 'envelope'

type WrapHullOptions = {
  smoothRadius: number
  mode: WrapHullMode
  convexify?: boolean
}

const stage = document.getElementById('stage') as HTMLDivElement

type DomCache = {
  headline: HTMLHeadingElement // cache lifetime: page
  credit: HTMLParagraphElement // cache lifetime: page
  openaiLogo: HTMLImageElement // cache lifetime: page
  claudeLogo: HTMLImageElement // cache lifetime: page
  headlineLines: HTMLDivElement[] // cache lifetime: headline line count
  bodyLines: HTMLDivElement[] // cache lifetime: visible line count
}

const preparedByKey = new Map<string, PreparedTextWithSegments>()
const wrapHullByKey = new Map<string, Promise<Point[]>>()
const scheduled = { value: false }
let currentLogoHits: { openai: Point[], claude: Point[] } | null = null
let hoveredLogo: LogoKind | null = null
let openaiAngle = 0
let claudeAngle = 0
let openaiSpin: {
  from: number
  to: number
  start: number
  duration: number
} | null = null
let claudeSpin: {
  from: number
  to: number
  start: number
  duration: number
} | null = null

const domCache: DomCache = {
  headline: createHeadline(),
  credit: createCredit(),
  openaiLogo: createLogo('logo logo--openai', 'OpenAI symbol', OPENAI_LOGO_SRC),
  claudeLogo: createLogo('logo logo--claude', 'Claude symbol', CLAUDE_LOGO_SRC),
  headlineLines: [],
  bodyLines: [],
}
let mounted = false

function createHeadline(): HTMLHeadingElement {
  const element = document.createElement('h1')
  element.className = 'headline'
  return element
}

function createCredit(): HTMLParagraphElement {
  const element = document.createElement('p')
  element.className = 'credit'
  element.textContent = 'Leopold Aschenbrenner'
  return element
}

function createLogo(className: string, alt: string, src: string): HTMLImageElement {
  const element = document.createElement('img')
  element.className = className
  element.alt = alt
  element.src = src
  element.draggable = false
  return element
}

function ensureMounted(): void {
  if (mounted) return
  stage.append(
    domCache.headline,
    domCache.credit,
    domCache.openaiLogo,
    domCache.claudeLogo,
  )
  mounted = true
}

function getTypography(): { font: string, lineHeight: number } {
  return { font: BODY_FONT, lineHeight: BODY_LINE_HEIGHT }
}

function getPrepared(text: string, font: string): PreparedTextWithSegments {
  const key = `${font}::${text}`
  const cached = preparedByKey.get(key)
  if (cached !== undefined) return cached
  const prepared = prepareWithSegments(text, font)
  preparedByKey.set(key, prepared)
  return prepared
}

async function makeWrapHull(src: string, options: WrapHullOptions): Promise<Point[]> {
  const image = new Image()
  image.src = src
  await image.decode()

  const maxDimension = 320
  const aspect = image.naturalWidth / image.naturalHeight
  const width = aspect >= 1
    ? maxDimension
    : Math.max(64, Math.round(maxDimension * aspect))
  const height = aspect >= 1
    ? Math.max(64, Math.round(maxDimension / aspect))
    : maxDimension

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('2d context unavailable')

  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)

  const { data } = ctx.getImageData(0, 0, width, height)
  const lefts: Array<number | null> = new Array(height).fill(null)
  const rights: Array<number | null> = new Array(height).fill(null)
  const alphaThreshold = 12

  for (let y = 0; y < height; y++) {
    let left = -1
    let right = -1
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3]!
      if (alpha < alphaThreshold) continue
      if (left === -1) left = x
      right = x
    }
    if (left !== -1 && right !== -1) {
      lefts[y] = left
      rights[y] = right + 1
    }
  }

  const validRows: number[] = []
  for (let y = 0; y < height; y++) {
    if (lefts[y] !== null && rights[y] !== null) validRows.push(y)
  }
  if (validRows.length === 0) throw new Error(`No opaque pixels found in ${src}`)

  let boundLeft = Infinity
  let boundRight = -Infinity
  const boundTop = validRows[0]!
  const boundBottom = validRows[validRows.length - 1]!
  for (const y of validRows) {
    const left = lefts[y]!
    const right = rights[y]!
    if (left < boundLeft) boundLeft = left
    if (right > boundRight) boundRight = right
  }
  const boundWidth = Math.max(1, boundRight - boundLeft)
  const boundHeight = Math.max(1, boundBottom - boundTop)

  const { smoothRadius, mode } = options
  const smoothedLefts: number[] = new Array(height).fill(0)
  const smoothedRights: number[] = new Array(height).fill(0)

  for (const y of validRows) {
    let leftSum = 0
    let rightSum = 0
    let count = 0
    let leftEdge = Infinity
    let rightEdge = -Infinity
    for (let offset = -smoothRadius; offset <= smoothRadius; offset++) {
      const sampleIndex = y + offset
      if (sampleIndex < 0 || sampleIndex >= height) continue
      const left = lefts[sampleIndex]
      const right = rights[sampleIndex]
      if (left == null || right == null) continue
      leftSum += left
      rightSum += right
      if (left < leftEdge) leftEdge = left
      if (right > rightEdge) rightEdge = right
      count++
    }

    if (count === 0) {
      smoothedLefts[y] = 0
      smoothedRights[y] = width
      continue
    }

    if (mode === 'envelope') {
      smoothedLefts[y] = leftEdge
      smoothedRights[y] = rightEdge
    } else {
      smoothedLefts[y] = leftSum / count
      smoothedRights[y] = rightSum / count
    }
  }

  const step = Math.max(1, Math.floor(validRows.length / 52))
  const sampledRows: number[] = []
  for (let index = 0; index < validRows.length; index += step) {
    sampledRows.push(validRows[index]!)
  }
  const lastRow = validRows[validRows.length - 1]!
  if (sampledRows[sampledRows.length - 1] !== lastRow) sampledRows.push(lastRow)

  const points: Point[] = []
  for (const y of sampledRows) {
    points.push({
      x: (smoothedLefts[y]! - boundLeft) / boundWidth,
      y: ((y + 0.5) - boundTop) / boundHeight,
    })
  }
  for (let index = sampledRows.length - 1; index >= 0; index--) {
    const y = sampledRows[index]!
    points.push({
      x: (smoothedRights[y]! - boundLeft) / boundWidth,
      y: ((y + 0.5) - boundTop) / boundHeight,
    })
  }

  if (!options.convexify) return points
  return makeConvexHull(points)
}

function getWrapHull(src: string, options: WrapHullOptions): Promise<Point[]> {
  const key = `${src}::${options.mode}::${options.smoothRadius}::${options.convexify ? 'convex' : 'raw'}`
  const cached = wrapHullByKey.get(key)
  if (cached !== undefined) return cached
  const promise = makeWrapHull(src, options)
  wrapHullByKey.set(key, promise)
  return promise
}

function cross(origin: Point, a: Point, b: Point): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
}

function makeConvexHull(points: Point[]): Point[] {
  if (points.length <= 3) return points
  const sorted = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y))
  const lower: Point[] = []
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) {
      lower.pop()
    }
    lower.push(point)
  }
  const upper: Point[] = []
  for (let index = sorted.length - 1; index >= 0; index--) {
    const point = sorted[index]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) {
      upper.pop()
    }
    upper.push(point)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

function transformWrapPoints(points: Point[], rect: Rect, angle: number): Point[] {
  if (angle === 0) {
    return points.map(point => ({
      x: rect.x + point.x * rect.width,
      y: rect.y + point.y * rect.height,
    }))
  }

  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)

  return points.map(point => {
    const localX = (point.x - 0.5) * rect.width
    const localY = (point.y - 0.5) * rect.height
    return {
      x: centerX + localX * cos - localY * sin,
      y: centerY + localX * sin + localY * cos,
    }
  })
}

function isPointInPolygon(points: Point[], x: number, y: number): boolean {
  let inside = false
  for (let index = 0, prev = points.length - 1; index < points.length; prev = index++) {
    const a = points[index]!
    const b = points[prev]!
    const intersects =
      ((a.y > y) !== (b.y > y)) &&
      (x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x)
    if (intersects) inside = !inside
  }
  return inside
}

function getPolygonXsAtY(points: Point[], y: number): number[] {
  const xs: number[] = []

  for (let index = 0; index < points.length; index++) {
    const start = points[index]!
    const end = points[(index + 1) % points.length]!
    if (start.y === end.y) continue

    const minY = Math.min(start.y, end.y)
    const maxY = Math.max(start.y, end.y)
    if (y < minY || y >= maxY) continue

    const t = (y - start.y) / (end.y - start.y)
    xs.push(start.x + (end.x - start.x) * t)
  }

  return xs.sort((a, b) => a - b)
}

function getPolygonIntervalForBand(
  points: Point[],
  bandTop: number,
  bandBottom: number,
  horizontalPadding: number,
  verticalPadding: number,
): Interval | null {
  const sampleTop = bandTop - verticalPadding
  const sampleBottom = bandBottom + verticalPadding
  const startY = Math.floor(sampleTop)
  const endY = Math.ceil(sampleBottom)

  let left = Infinity
  let right = -Infinity

  for (let y = startY; y <= endY; y++) {
    const xs = getPolygonXsAtY(points, y + 0.5)
    for (let index = 0; index + 1 < xs.length; index += 2) {
      const runLeft = xs[index]!
      const runRight = xs[index + 1]!
      if (runLeft < left) left = runLeft
      if (runRight > right) right = runRight
    }
  }

  if (!Number.isFinite(left) || !Number.isFinite(right)) return null
  return { left: left - horizontalPadding, right: right + horizontalPadding }
}

function getRectIntervalsForBand(
  rects: Rect[],
  bandTop: number,
  bandBottom: number,
  horizontalPadding: number,
  verticalPadding: number,
): Interval[] {
  const intervals: Interval[] = []
  for (const rect of rects) {
    if (bandBottom <= rect.y - verticalPadding || bandTop >= rect.y + rect.height + verticalPadding) continue
    intervals.push({
      left: rect.x - horizontalPadding,
      right: rect.x + rect.width + horizontalPadding,
    })
  }
  return intervals
}

function subtractIntervals(base: Interval, intervals: Interval[]): Interval[] {
  let slots: Interval[] = [base]

  for (const interval of intervals) {
    const next: Interval[] = []
    for (const slot of slots) {
      if (interval.right <= slot.left || interval.left >= slot.right) {
        next.push(slot)
        continue
      }
      if (interval.left > slot.left) {
        next.push({ left: slot.left, right: interval.left })
      }
      if (interval.right < slot.right) {
        next.push({ left: interval.right, right: slot.right })
      }
    }
    slots = next
  }

  return slots.filter(slot => slot.right - slot.left >= 24)
}

function layoutColumn(
  prepared: PreparedTextWithSegments,
  startCursor: LayoutCursor,
  region: Rect,
  lineHeight: number,
  obstacles: BandObstacle[],
  side: 'left' | 'right',
): { lines: PositionedLine[], cursor: LayoutCursor } {
  let cursor: LayoutCursor = startCursor
  let lineTop = region.y
  const lines: PositionedLine[] = []

  while (true) {
    if (lineTop + lineHeight > region.y + region.height) break

    const bandTop = lineTop
    const bandBottom = lineTop + lineHeight
    const blocked: Interval[] = []
    for (const obstacle of obstacles) {
      blocked.push(...obstacle.getIntervals(bandTop, bandBottom))
    }

    const slots = subtractIntervals(
      { left: region.x, right: region.x + region.width },
      blocked,
    )
    if (slots.length === 0) {
      lineTop += lineHeight
      continue
    }

    const slot = slots.reduce((best, candidate) => {
      const bestWidth = best.right - best.left
      const candidateWidth = candidate.right - candidate.left
      if (candidateWidth > bestWidth) return candidate
      if (candidateWidth < bestWidth) return best
      if (side === 'left') return candidate.left > best.left ? candidate : best
      return candidate.left < best.left ? candidate : best
    })
    const width = slot.right - slot.left
    const line = layoutNextLine(prepared, cursor, width)
    if (line === null) break

    lines.push({
      x: Math.round(slot.left),
      y: Math.round(lineTop),
      text: line.text,
    })

    cursor = line.end
    lineTop += lineHeight
  }

  return { lines, cursor }
}

function syncPool<T extends HTMLElement>(
  pool: T[],
  length: number,
  create: () => T,
  parent: HTMLElement = stage,
): void {
  while (pool.length < length) {
    const element = create()
    pool.push(element)
    parent.appendChild(element)
  }
  while (pool.length > length) {
    const element = pool.pop()!
    element.remove()
  }
}

function projectHeadlineLines(lines: LayoutLine[], font: string, lineHeight: number): void {
  syncPool(domCache.headlineLines, lines.length, () => {
    const element = document.createElement('div')
    element.className = 'headline-line'
    return element
  }, domCache.headline)

  for (const [index, line] of lines.entries()) {
    const element = domCache.headlineLines[index]!
    element.textContent = line.text
    element.style.left = '0px'
    element.style.top = `${index * lineHeight}px`
    element.style.font = font
    element.style.lineHeight = `${lineHeight}px`
  }
}

function projectBodyLines(lines: PositionedLine[], className: string, font: string, lineHeight: number, startIndex: number): number {
  for (const [offset, line] of lines.entries()) {
    const element = domCache.bodyLines[startIndex + offset]!
    element.className = className
    element.textContent = line.text
    element.style.left = `${line.x}px`
    element.style.top = `${line.y}px`
    element.style.font = font
    element.style.lineHeight = `${lineHeight}px`
  }
  return startIndex + lines.length
}

function projectStaticLayout(layout: ReturnType<typeof buildLayout>): void {
  ensureMounted()
  stage.style.height = `${document.documentElement.clientHeight}px`

  domCache.openaiLogo.style.left = `${layout.openaiRect.x}px`
  domCache.openaiLogo.style.top = `${layout.openaiRect.y}px`
  domCache.openaiLogo.style.width = `${layout.openaiRect.width}px`
  domCache.openaiLogo.style.height = `${layout.openaiRect.height}px`
  domCache.openaiLogo.style.transform = `rotate(${openaiAngle}rad)`

  domCache.claudeLogo.style.left = `${layout.claudeRect.x}px`
  domCache.claudeLogo.style.top = `${layout.claudeRect.y}px`
  domCache.claudeLogo.style.width = `${layout.claudeRect.width}px`
  domCache.claudeLogo.style.height = `${layout.claudeRect.height}px`
  domCache.claudeLogo.style.transform = `rotate(${claudeAngle}rad)`

  domCache.headline.style.left = `${layout.gutter}px`
  domCache.headline.style.top = `${layout.headlineTop}px`
  domCache.headline.style.width = `${layout.headlineWidth}px`
  domCache.headline.style.height = `${layout.headlineLines.length * layout.headlineLineHeight}px`
  domCache.headline.style.font = `700 ${layout.headlineFontSize}px ${HEADLINE_FONT_FAMILY}`
  domCache.headline.style.lineHeight = `${layout.headlineLineHeight}px`
  domCache.headline.style.letterSpacing = '0px'
  projectHeadlineLines(layout.headlineLines, `700 ${layout.headlineFontSize}px ${HEADLINE_FONT_FAMILY}`, layout.headlineLineHeight)

  domCache.credit.style.left = `${layout.gutter + 4}px`
  domCache.credit.style.top = `${layout.creditTop}px`
  domCache.credit.style.width = 'auto'
}

function getPreparedSingleLineWidth(text: string, font: string, lineHeight: number): number {
  const result = layoutWithLines(getPrepared(text, font), 10_000, lineHeight)
  return result.lines[0]?.width ?? 0
}

function titleLayoutKeepsWholeWords(lines: LayoutLine[]): boolean {
  const words = new Set(HEADLINE_TEXT.split(/\s+/))
  for (const line of lines) {
    const tokens = line.text.split(' ').filter(Boolean)
    for (const token of tokens) {
      if (!words.has(token)) return false
    }
  }
  return true
}

function fitHeadlineFontSize(headlineWidth: number, pageWidth: number): number {
  const maxSize = Math.min(94.4, Math.max(55.2, pageWidth * 0.055))
  let low = Math.max(22, pageWidth * 0.026)
  let high = maxSize
  let best = low
  const words = HEADLINE_TEXT.split(/\s+/)

  for (let iteration = 0; iteration < 10; iteration++) {
    const size = (low + high) / 2
    const lineHeight = Math.round(size * 0.92)
    const font = `700 ${size}px ${HEADLINE_FONT_FAMILY}`
    let widestWord = 0

    for (const word of words) {
      const width = getPreparedSingleLineWidth(word, font, lineHeight)
      if (width > widestWord) widestWord = width
    }

    const titleLayout = layoutWithLines(getPrepared(HEADLINE_TEXT, font), headlineWidth, lineHeight)
    if (widestWord <= headlineWidth - 8 && titleLayoutKeepsWholeWords(titleLayout.lines)) {
      best = size
      low = size
    } else {
      high = size
    }
  }

  return Math.round(best * 10) / 10
}

function setHoveredLogo(nextHovered: 'openai' | 'claude' | null): void {
  if (hoveredLogo === nextHovered) return
  hoveredLogo = nextHovered
  document.body.style.cursor = hoveredLogo === null ? 'default' : 'pointer'
}

function easeSpin(t: number): number {
  const oneMinusT = 1 - t
  return 1 - oneMinusT * oneMinusT * oneMinusT
}

function updateSpinState(now: number): boolean {
  let animating = false

  if (openaiSpin !== null) {
    const progress = Math.min(1, (now - openaiSpin.start) / openaiSpin.duration)
    openaiAngle = openaiSpin.from + (openaiSpin.to - openaiSpin.from) * easeSpin(progress)
    if (progress >= 1) {
      openaiAngle = openaiSpin.to
      openaiSpin = null
    } else {
      animating = true
    }
  }

  if (claudeSpin !== null) {
    const progress = Math.min(1, (now - claudeSpin.start) / claudeSpin.duration)
    claudeAngle = claudeSpin.from + (claudeSpin.to - claudeSpin.from) * easeSpin(progress)
    if (progress >= 1) {
      claudeAngle = claudeSpin.to
      claudeSpin = null
    } else {
      animating = true
    }
  }

  return animating
}

function startLogoSpin(kind: LogoKind, direction: 1 | -1): void {
  const now = performance.now()
  const delta = direction * Math.PI
  if (kind === 'openai') {
    openaiSpin = {
      from: openaiAngle,
      to: openaiAngle + delta,
      start: now,
      duration: 900,
    }
  } else {
    claudeSpin = {
      from: claudeAngle,
      to: claudeAngle + delta,
      start: now,
      duration: 900,
    }
  }
  scheduleRender()
}

function buildLayout(pageWidth: number, pageHeight: number, lineHeight: number): {
  gutter: number
  headlineTop: number
  headlineWidth: number
  headlineFontSize: number
  headlineLineHeight: number
  headlineLines: LayoutLine[]
  headlineRects: Rect[]
  creditTop: number
  leftRegion: Rect
  rightRegion: Rect
  openaiRect: Rect
  claudeRect: Rect
} {
  const gutter = Math.round(Math.max(52, pageWidth * 0.048))
  const centerGap = Math.round(Math.max(28, pageWidth * 0.025))
  const columnWidth = Math.round((pageWidth - gutter * 2 - centerGap) / 2)

  const headlineTop = Math.round(Math.max(42, pageWidth * 0.04))
  const headlineWidth = Math.round(Math.min(pageWidth - gutter * 2, Math.max(columnWidth, pageWidth * 0.5)))
  const headlineFontSize = fitHeadlineFontSize(headlineWidth, pageWidth)
  const headlineLineHeight = Math.round(headlineFontSize * 0.92)
  const headlineFont = `700 ${headlineFontSize}px ${HEADLINE_FONT_FAMILY}`
  const headlineResult = layoutWithLines(
    prepareWithSegments(HEADLINE_TEXT, headlineFont),
    headlineWidth,
    headlineLineHeight,
  )
  const headlineLines = headlineResult.lines
  const headlineRects = headlineLines.map((line, index) => ({
    x: gutter,
    y: headlineTop + index * headlineLineHeight,
    width: Math.ceil(line.width),
    height: headlineLineHeight,
  }))

  const creditGap = Math.round(Math.max(14, lineHeight * 0.6))
  const creditTop = headlineTop + headlineResult.height + creditGap
  const copyTop = creditTop + CREDIT_LINE_HEIGHT + Math.round(Math.max(20, lineHeight * 0.9))

  const openaiTopLimit = copyTop + Math.round(lineHeight * 1.95)
  const maxOpenaiSizeByHeight = Math.floor((pageHeight - gutter - openaiTopLimit) / 1.03)
  const openaiWidthFactor = Math.min(0.226, 0.198 + Math.max(0, 1100 - pageWidth) * 0.00006)
  const openaiSize = Math.round(Math.max(148, Math.min(366, pageWidth * openaiWidthFactor, maxOpenaiSizeByHeight)))
  const claudeSize = Math.round(Math.max(252, Math.min(428, pageWidth * 0.34, pageHeight * 0.42)))

  const leftRegion: Rect = {
    x: gutter,
    y: copyTop,
    width: columnWidth,
    height: pageHeight - copyTop - gutter,
  }

  const rightRegion: Rect = {
    x: gutter + columnWidth + centerGap,
    y: headlineTop,
    width: columnWidth,
    height: pageHeight - headlineTop - gutter,
  }

  const openaiRect: Rect = {
    x: leftRegion.x - Math.round(openaiSize * 0.41),
    y: pageHeight - gutter - openaiSize + Math.round(openaiSize * 0.2),
    width: openaiSize,
    height: openaiSize,
  }

  const claudeRect: Rect = {
    x: pageWidth - Math.round(claudeSize * 0.94),
    y: Math.round(claudeSize * 0.012),
    width: claudeSize,
    height: claudeSize,
  }

  return {
    gutter,
    headlineTop,
    headlineWidth,
    headlineFontSize,
    headlineLineHeight,
    headlineLines,
    headlineRects,
    creditTop,
    leftRegion,
    rightRegion,
    openaiRect,
    claudeRect,
  }
}

async function evaluateLayout(
  layout: ReturnType<typeof buildLayout>,
  lineHeight: number,
  preparedBody: PreparedTextWithSegments,
): Promise<{
  leftLines: PositionedLine[]
  rightLines: PositionedLine[]
}> {
  const [openaiHull, claudeHull] = await Promise.all([
    getWrapHull(domCache.openaiLogo.src, { smoothRadius: 6, mode: 'mean' }),
    getWrapHull(domCache.claudeLogo.src, { smoothRadius: 24, mode: 'envelope', convexify: true }),
  ])
  const openaiWrap = transformWrapPoints(openaiHull, layout.openaiRect, openaiAngle)
  const claudeWrapRect: Rect = {
    x: layout.claudeRect.x - Math.round(layout.claudeRect.width * 0.045),
    y: layout.claudeRect.y - Math.round(layout.claudeRect.height * 0.045),
    width: Math.round(layout.claudeRect.width * 1.08),
    height: Math.round(layout.claudeRect.height * 1.08),
  }
  const claudeCapRect: Rect = {
    x: layout.claudeRect.x - Math.round(layout.claudeRect.width * 0.015),
    y: layout.claudeRect.y + Math.round(layout.claudeRect.height * 0.09),
    width: Math.round(layout.claudeRect.width * 0.92),
    height: Math.round(layout.claudeRect.height * 0.16),
  }
  const claudeWrap = transformWrapPoints(claudeHull, claudeWrapRect, claudeAngle)

  const openaiObstacle: BandObstacle = {
    getIntervals(bandTop, bandBottom) {
      const interval = getPolygonIntervalForBand(
        openaiWrap,
        bandTop,
        bandBottom,
        Math.round(lineHeight * 0.82),
        Math.round(lineHeight * 0.26),
      )
      return interval === null ? [] : [interval]
    },
  }

  const claudeObstacle: BandObstacle = {
    getIntervals(bandTop, bandBottom) {
      const intervals: Interval[] = []
      const interval = getPolygonIntervalForBand(
        claudeWrap,
        bandTop,
        bandBottom,
        Math.round(lineHeight * 0.92),
        Math.round(lineHeight * 0.48),
      )
      if (interval !== null) intervals.push(interval)
      intervals.push(...getRectIntervalsForBand(
        [claudeCapRect],
        bandTop,
        bandBottom,
        Math.round(lineHeight * 0.72),
        Math.round(lineHeight * 0.38),
      ))
      return intervals
    },
  }

  const titleObstacle: BandObstacle = {
    getIntervals(bandTop, bandBottom) {
      return getRectIntervalsForBand(
        layout.headlineRects,
        bandTop,
        bandBottom,
        Math.round(lineHeight * 0.95),
        Math.round(lineHeight * 0.3),
      )
    },
  }

  const leftResult = layoutColumn(
    preparedBody,
    { segmentIndex: 0, graphemeIndex: 0 },
    layout.leftRegion,
    lineHeight,
    [openaiObstacle],
    'left',
  )

  const rightResult = layoutColumn(
    preparedBody,
    leftResult.cursor,
    layout.rightRegion,
    lineHeight,
    [titleObstacle, claudeObstacle, openaiObstacle],
    'right',
  )

  return {
    leftLines: leftResult.lines,
    rightLines: rightResult.lines,
  }
}

async function render(now = performance.now()): Promise<void> {
  const { font, lineHeight } = getTypography()
  const root = document.documentElement
  const pageWidth = root.clientWidth
  const pageHeight = root.clientHeight
  const animating = updateSpinState(now)
  const preparedBody = getPrepared(BODY_COPY, font)
  const layout = buildLayout(pageWidth, pageHeight, lineHeight)
  projectStaticLayout(layout)
  const { leftLines, rightLines } = await evaluateLayout(layout, lineHeight, preparedBody)
  syncPool(domCache.bodyLines, leftLines.length + rightLines.length, () => {
    const element = document.createElement('div')
    element.className = 'line'
    return element
  })
  let nextIndex = 0
  nextIndex = projectBodyLines(leftLines, 'line line--left', font, lineHeight, nextIndex)
  projectBodyLines(rightLines, 'line line--right', font, lineHeight, nextIndex)

  const [openaiHitHull, claudeHitHull] = await Promise.all([
    getWrapHull(domCache.openaiLogo.src, { smoothRadius: 3, mode: 'mean' }),
    getWrapHull(domCache.claudeLogo.src, { smoothRadius: 5, mode: 'mean' }),
  ])
  currentLogoHits = {
    openai: transformWrapPoints(openaiHitHull, layout.openaiRect, openaiAngle),
    claude: transformWrapPoints(claudeHitHull, layout.claudeRect, claudeAngle),
  }

  if (animating || openaiSpin !== null || claudeSpin !== null) {
    scheduleRender()
  }
}

function scheduleRender(): void {
  if (scheduled.value) return
  scheduled.value = true
  requestAnimationFrame(() => {
    scheduled.value = false
    void render()
  })
}

window.addEventListener('resize', scheduleRender)
document.addEventListener('mousemove', event => {
  const hits = currentLogoHits
  if (hits === null) {
    setHoveredLogo(null)
    return
  }
  const x = event.clientX
  const y = event.clientY
  const nextHovered =
    isPointInPolygon(hits.openai, x, y)
      ? 'openai'
      : isPointInPolygon(hits.claude, x, y)
        ? 'claude'
        : null
  setHoveredLogo(nextHovered)
})
window.addEventListener('blur', () => {
  setHoveredLogo(null)
})
document.addEventListener('click', event => {
  const hits = currentLogoHits
  if (hits === null) return
  const x = event.clientX
  const y = event.clientY

  if (isPointInPolygon(hits.openai, x, y)) {
    startLogoSpin('openai', -1)
    return
  }

  if (isPointInPolygon(hits.claude, x, y)) {
    startLogoSpin('claude', 1)
  }
})
void document.fonts.ready.then(() => {
  scheduleRender()
})
scheduleRender()
