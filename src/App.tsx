import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { audio } from './audio'
import { FiSettings } from 'react-icons/fi'
import { IoClose } from 'react-icons/io5'
import { Renderer, Stave, StaveNote, Accidental, Formatter, Voice } from 'vexflow'

type StringCount = 4 | 5 | 6

type Target = {
  stringIndex: number // 0 = bottom (lowest pitch)
  fret: number // 0..N (0 = open)
}

type BoardTheme = 'ebony' | 'maple' | 'rosewood' | 'pauferro'
type InlayStyle = 'dot' | 'block' | 'none'
type ProblemView = 'text' | 'staff'

// Note: textual tuning kept implicit via OPEN_MIDIS and midiToNameOctave

// MIDI numbers for open strings in standard tuning (bottom=lowest pitch)
// 4: E1(28), A1(33), D2(38), G2(43)
// 5: B0(23), E1(28), A1(33), D2(38), G2(43)
// 6: B0(23), E1(28), A1(33), D2(38), G2(43), C3(48)
const OPEN_MIDIS: Record<StringCount, number[]> = {
  4: [28, 33, 38, 43],
  5: [23, 28, 33, 38, 43],
  6: [23, 28, 33, 38, 43, 48],
}

// open string names no longer used for hinting

const NOTE_NAMES_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] as const
function midiToNameOctave(midi: number): string {
  const name = NOTE_NAMES_SHARP[midi % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${name}${octave}`
}

// Persist simple values in localStorage
function usePersistedState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  }, [key, value])
  return [value, setValue] as const
}

function useShake(ms = 350) {
  const [shaking, setShaking] = useState(false)
  const timer = useRef<number | null>(null)
  const trigger = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    setShaking(true)
    timer.current = window.setTimeout(() => setShaking(false), ms)
  }, [ms])
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  return { shaking, trigger }
}

function App() {
  const [stringCount, setStringCount] = usePersistedState<StringCount>('bf:stringCount', 4)
  const [frets, setFrets] = usePersistedState<number>('bf:frets', 21)
  const [theme, setTheme] = usePersistedState<BoardTheme>('bf:theme', 'ebony')
  const [inlay, setInlay] = usePersistedState<InlayStyle>('bf:inlay', 'dot')
  const [flipBoth, setFlipBoth] = usePersistedState<boolean>('bf:flipBoth', false)
  const [soundOn, setSoundOn] = usePersistedState<boolean>('bf:soundOn', true)
  const [problemView, setProblemView] = usePersistedState<ProblemView>('bf:problemView', 'text')
  const [sideDots, setSideDots] = usePersistedState<boolean>('bf:sideDots', false)
  const [binding, setBinding] = usePersistedState<boolean>('bf:binding', false)

  // Always running quiz flow
  const [currentMidi, setCurrentMidi] = useState<number | null>(null)
  
  const { shaking, trigger } = useShake()
  const [showDamage, setShowDamage] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [prevBanner, setPrevBanner] = useState<string | null>(null)
  const prevLabelRef = useRef<string | null>(null)
  // guard against rapid multi-taps causing double-advance
  const lastHitTsRef = useRef<number>(0)
  const pendingNextRef = useRef<boolean>(false)
  const [controlsOpen, setControlsOpen] = useState<boolean>(false)

  // Unique set of targetable MIDI notes (optionally include open)
  const possibleMidis = useMemo(() => {
    const s = new Set<number>()
    for (let i = 0; i < stringCount; i += 1) {
      const open = OPEN_MIDIS[stringCount][i]
      for (let f = 0; f <= frets; f += 1) s.add(open + f)
    }
    return Array.from(s)
  }, [stringCount, frets])

  // Non-repeating deck of targets (across distinct notes)
  const [, setDeck] = useState<number[]>([])
  const shuffle = <T,>(arr: T[]): T[] => {
    const a = arr.slice()
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = a[i]
      a[i] = a[j]
      a[j] = tmp
    }
    return a
  }

  useEffect(() => {
    setDeck(shuffle(possibleMidis))
    setCurrentMidi(null)
  }, [possibleMidis])

  const nextTarget = useCallback(() => {
    setDeck((prev) => {
      let d = prev
      if (!d || d.length === 0) d = shuffle(possibleMidis)
      const [head, ...rest] = d
      setCurrentMidi(head ?? null)
      return rest
    })
  }, [possibleMidis])

  useEffect(() => {
    if (currentMidi == null) {
      nextTarget()
    }
  }, [currentMidi, nextTarget])

  // Ensure first target is created immediately on mount
  useEffect(() => {
    nextTarget()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When tuning or fret count changes, request a new target
  useEffect(() => {
    setCurrentMidi(null)
  }, [stringCount, frets])

  // Animate problem banner on change
  useEffect(() => {
    if (currentMidi == null) return
    const label = midiToNameOctave(currentMidi)
    // move current label to previous for exit animation
    setPrevBanner(prevLabelRef.current)
    setBanner(label)
    prevLabelRef.current = label
    const t = window.setTimeout(() => setPrevBanner(null), 500)
    return () => window.clearTimeout(t)
  }, [currentMidi])

  const onHit = useCallback(
    (hit: Target) => {
      const nowTs = performance.now()
      if (nowTs - lastHitTsRef.current < 60) return
      lastHitTsRef.current = nowTs
      if (currentMidi == null) return
      const midi = OPEN_MIDIS[stringCount][hit.stringIndex] + hit.fret
      // Play the pressed note (stop previous first) if enabled
      if (soundOn) {
        try {
          audio.ensure()
          audio.playMidi(midi)
        } catch {}
      }
      const ok = midi === currentMidi
      if (ok) {
        if (!pendingNextRef.current) {
          pendingNextRef.current = true
          requestAnimationFrame(() => {
            nextTarget()
            pendingNextRef.current = false
          })
        }
      } else {
        // wrong feedback: shake + red overlay
        trigger()
        setShowDamage(true)
        setTimeout(() => setShowDamage(false), 350)
      }
    },
    [currentMidi, nextTarget, trigger, stringCount, soundOn],
  )

  // Immediately stop any ringing note when sound is toggled off
  useEffect(() => {
    if (!soundOn) {
      try { audio.stopCurrent(40) } catch {}
    }
  }, [soundOn])


  return (
    <div className={`app-root ${showDamage ? 'damage' : ''}`}>
      <div className="viewport">
        <div className={`stage ${shaking ? 'shake' : ''}`}>
        <Fretboard
          stringCount={stringCount}
          frets={frets}
          theme={theme}
          inlayStyle={inlay}
          sideDots={sideDots}
          binding={binding}
          flipBoth={flipBoth}
          onHit={onHit}
        />
          {/* red overlay handled by .app-root.damage via CSS */}
        </div>
        {prevBanner && (
          <div className="problem-banner exit">{problemView === 'staff' ? <StaffNote midi={currentMidi!} /> : prevBanner}</div>
        )}
        {banner && (
          <div className="problem-banner enter">{problemView === 'staff' ? <StaffNote midi={currentMidi!} /> : banner}</div>
        )}
        <div className={`floating-controls ${controlsOpen ? 'open' : ''}`}>
          <button
            className="controls-toggle"
            aria-expanded={controlsOpen}
            aria-label="설정"
            onClick={() => setControlsOpen((v) => !v)}
          >
            {controlsOpen ? <IoClose size={28} /> : <FiSettings size={26} />}
          </button>
          <div className="controls-body">
          <label className="control small">
            <span>현 수</span>
            <select
              value={stringCount}
              onChange={(e) => setStringCount(Number(e.target.value) as StringCount)}
            >
              <option value={4}>4</option>
              <option value={5}>5</option>
              <option value={6}>6</option>
            </select>
          </label>
          <label className="control small">
            <span>프렛</span>
            <select value={frets} onChange={(e) => setFrets(Number(e.target.value))}>
              <option value={12}>12</option>
              <option value={21}>21</option>
              <option value={22}>22</option>
              <option value={23}>23</option>
              <option value={24}>24</option>
            </select>
          </label>
          <label className="control small">
            <span>지판</span>
            <select value={theme} onChange={(e) => setTheme(e.target.value as BoardTheme)}>
              <option value="ebony">에보니</option>
              <option value="maple">메이플</option>
              <option value="rosewood">로즈우드</option>
              <option value="pauferro">포페로</option>
            </select>
          </label>
          <label className="control small">
            <span>인레이</span>
            <select value={inlay} onChange={(e) => setInlay(e.target.value as InlayStyle)}>
              <option value="dot">닷</option>
              <option value="block">블록</option>
              <option value="none">없음</option>
            </select>
          </label>
          <label className="control small">
            <span>소리 재생</span>
            <input
              type="checkbox"
              checked={soundOn}
              onChange={(e) => setSoundOn(e.target.checked)}
            />
          </label>
          <label className="control small">
            <span>문제 표시</span>
            <select
              value={problemView}
              onChange={(e) => setProblemView(e.target.value as ProblemView)}
            >
              <option value="text">텍스트</option>
              <option value="staff">악보</option>
            </select>
          </label>
          <label className="control small">
            <span>사이드닷</span>
            <input
              type="checkbox"
              checked={sideDots}
              onChange={(e) => setSideDots(e.target.checked)}
            />
          </label>
          <label className="control small">
            <span>바인딩</span>
            <input
              type="checkbox"
              checked={binding}
              onChange={(e) => setBinding(e.target.checked)}
            />
          </label>
          <label className="control small">
            <span>상하좌우 반전</span>
            <input
              type="checkbox"
              checked={flipBoth}
              onChange={(e) => setFlipBoth(e.target.checked)}
            />
          </label>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App

type FretboardProps = {
  stringCount: StringCount
  frets: number
  onHit: (hit: Target) => void
  theme: BoardTheme
  inlayStyle: InlayStyle
  sideDots?: boolean
  binding?: boolean
  flipBoth?: boolean
}

function Fretboard({ stringCount, frets, onHit, theme, inlayStyle, sideDots, binding, flipBoth }: FretboardProps) {
  // SVG geometry
  const width = 1600
  const heightPerString = 44
  const paddingY = 24
  const nutWidth = 10
  const boardHeight = stringCount * heightPerString + paddingY * 2
  const bindingThickness = binding ? 10 : 0
  const sideRailHeight = sideDots && !binding ? 10 : 0
  const totalHeight = bindingThickness * 2 + boardHeight + sideRailHeight
  const boardTopY = bindingThickness
  const boardBottomY = boardTopY + boardHeight
  const scaleLength = 1000 // px, relative scale for fret spacing
  const openPad = 18 // extra clickable pad right of nut for open strings (larger for touch)
  const FRET_WIDTH = 5
  // Theme-tinted side rail and nut side color
  const railFill = useMemo(() => {
    switch (theme) {
      case 'ebony':
        return '#2a2521'
      case 'maple':
        return '#c18a40'
      case 'rosewood':
        return '#472a21'
      case 'pauferro':
        return '#7a5635'
      default:
        return '#2a2521'
    }
  }, [theme])
  const railStroke = useMemo(() => {
    switch (theme) {
      case 'ebony':
        return '#211d1a'
      case 'maple':
        return '#a87635'
      case 'rosewood':
        return '#3d251d'
      case 'pauferro':
        return '#6a4a2f'
      default:
        return '#211d1a'
    }
  }, [theme])
  const nutSideFill = '#d8d1c2'

  // Fret positions from nut (x)
  const fretXs = useMemo(() => {
    const xs: number[] = [0]
    for (let n = 1; n <= frets; n += 1) {
      const d = scaleLength - scaleLength / Math.pow(2, n / 12)
      xs.push(d)
    }
    // Normalize to fit width minus margin on right
    const full = xs[xs.length - 1]
    const marginRight = 30
    const scale = (width - marginRight - nutWidth) / full
    return xs.map((x) => nutWidth + x * scale)
  }, [frets])

  // String centers (bottom = lowest pitch)
  const stringYs = useMemo(() => {
    const ys: number[] = []
    const usable = boardHeight - paddingY * 2
    for (let i = 0; i < stringCount; i += 1) {
      // index 0 -> bottom line, index last -> top line
      const y = boardTopY + paddingY + (usable * (stringCount - 1 - i)) / (stringCount - 1 || 1)
      ys.push(y)
    }
    return ys
  }, [boardTopY, boardHeight, paddingY, stringCount])

  // Inlay positions up to current fret count
  const inlayFrets = useMemo(() => {
    const base = [3, 5, 7, 9, 12, 15, 17, 19]
    if (frets >= 21) base.push(21)
    if (frets >= 24) base.push(24)
    return base.filter((n) => n <= frets)
  }, [frets])

  // Hit test utility: from pointer to stringIndex/fret
  const pickHit = (sp: DOMPoint) => {
    // nearest string
    let stringIndex = 0
    let minDy = Infinity
    stringYs.forEach((y, i) => {
      const dy = Math.abs(sp.y - y)
      if (dy < minDy) { minDy = dy; stringIndex = i }
    })
    // open string zone with grace: extend slightly into first-fret area
    const firstFretX = fretXs[1] ?? (nutWidth + 60)
    const openGrace = Math.min(24, (firstFretX - nutWidth) * 0.25)
    if (sp.x <= nutWidth + openPad + openGrace) {
      return { stringIndex, fret: 0 }
    }
    // fret region n between x_{n-1} and x_n
    let fret = -1
    const pad = Math.max(3, Math.ceil(FRET_WIDTH / 2) + 1)
    for (let n = 1; n <= frets; n += 1) {
      let x0 = fretXs[n - 1]
      let x1 = fretXs[n]
      if (x1 - x0 > pad * 2) { x0 += pad; x1 -= pad }
      if (sp.x >= x0 && sp.x < x1) { fret = n; break }
    }
    if (fret === -1) return null
    return { stringIndex, fret }
  }

  // Hover position highlight (follows mouse, shows where click will register)
  const [hover, setHover] = useState<Target | null>(null)

  // Click handling uses hit test
  const handlePointerDown = (evt: React.PointerEvent<SVGSVGElement>) => {
    const svg = evt.currentTarget
    const pt = svg.createSVGPoint()
    pt.x = evt.clientX
    pt.y = evt.clientY
    let sp = pt.matrixTransform(svg.getScreenCTM()?.inverse())
    // Safari portrait + rotated viewport fallback mapping
    if (window.matchMedia && window.matchMedia('(orientation: portrait)').matches) {
      const rect = svg.getBoundingClientRect()
      const u = (evt.clientX - rect.left) / rect.width
      const v = (evt.clientY - rect.top) / rect.height
      // viewport is rotated +90deg; invert rotation: x = v, y = 1 - u
      sp = new DOMPoint(width * v, boardHeight * (1 - u))
    }
    if (flipBoth) sp = new DOMPoint(width - sp.x, boardHeight - sp.y)
    const hit = pickHit(sp)
    if (!hit) return
    setHover(hit)
    onHit(hit)
  }

  const handlePointerMove = (evt: React.PointerEvent<SVGSVGElement>) => {
    const svg = evt.currentTarget
    const pt = svg.createSVGPoint()
    pt.x = evt.clientX
    pt.y = evt.clientY
    let sp = pt.matrixTransform(svg.getScreenCTM()?.inverse())
    if (window.matchMedia && window.matchMedia('(orientation: portrait)').matches) {
      const rect = svg.getBoundingClientRect()
      const u = (evt.clientX - rect.left) / rect.width
      const v = (evt.clientY - rect.top) / rect.height
      sp = new DOMPoint(width * v, boardHeight * (1 - u))
    }
    if (flipBoth) sp = new DOMPoint(width - sp.x, boardHeight - sp.y)
    const hit = pickHit(sp)
    setHover(hit)
  }

  const handlePointerLeave = () => setHover(null)

  // removed highlight position (no hint rendering)

  return (
      <svg
        className="fretboard"
        width={width}
        height={totalHeight}
        viewBox={`0 0 ${width} ${totalHeight}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        role="img"
        aria-label="베이스 지판"
      >
        {/* wood background */}
        <defs>
          {/* dynamic wood palette by theme */}
          <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1">
            {theme === 'ebony' && (
              <>
                <stop offset="0%" stopColor="#1f1b18" />
                <stop offset="50%" stopColor="#2a2521" />
                <stop offset="100%" stopColor="#151210" />
              </>
            )}
            {theme === 'maple' && (
              <>
                <stop offset="0%" stopColor="#e5b369" />
                <stop offset="50%" stopColor="#d19046" />
                <stop offset="100%" stopColor="#bf7a2f" />
              </>
            )}
            {theme === 'rosewood' && (
              <>
                <stop offset="0%" stopColor="#5a3a2e" />
                <stop offset="50%" stopColor="#472a21" />
                <stop offset="100%" stopColor="#3b221b" />
              </>
            )}
            {theme === 'pauferro' && (
              <>
                <stop offset="0%" stopColor="#6a4b2f" />
                <stop offset="50%" stopColor="#845f3b" />
                <stop offset="100%" stopColor="#573d27" />
              </>
            )}
          </linearGradient>
          <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f3f3f3" />
            <stop offset="50%" stopColor="#cfcfcf" />
            <stop offset="100%" stopColor="#e9e9e9" />
          </linearGradient>
          {/* roundwound string pattern */}
          <pattern id="rw" patternUnits="userSpaceOnUse" width="8" height="8">
            <rect x="0" y="0" width="8" height="8" fill="#b7c4cf" />
            <rect x="0" y="0" width="2" height="8" fill="#93a2ad" opacity="0.5" />
            <rect x="4" y="0" width="2" height="8" fill="#93a2ad" opacity="0.4" />
          </pattern>
          {/* pearloid (mother-of-pearl) gradient for block inlays */}
          <radialGradient id="pearl" cx="50%" cy="50%" r="75%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="35%" stopColor="#f0f4f7" />
            <stop offset="65%" stopColor="#e3e7ec" />
            <stop offset="100%" stopColor="#d6dbe1" />
          </radialGradient>
        </defs>

        <g transform={flipBoth ? `translate(${width},${boardHeight}) scale(-1,-1)` : undefined}>
          {/* board (no rounding) */}
        <rect x={0} y={boardTopY} width={width} height={boardHeight} fill="url(#wood)" />
        {binding && (
          <>
            <rect x={0} y={0} width={width} height={bindingThickness} fill="#e8e1cc" opacity={0.95} />
            <rect x={0} y={boardBottomY} width={width} height={bindingThickness} fill="#e8e1cc" opacity={0.95} />
          </>
        )}

          {/* nut */}
          <rect x={0} y={boardTopY} width={nutWidth} height={boardHeight} fill="#e5e2d8" />
          {/* open helper zone visual (subtle) */}
          <rect x={nutWidth} y={boardTopY} width={openPad} height={boardHeight} fill="#ffffff" opacity={0.04} />

          {/* frets */}
          {fretXs.slice(1).map((x, i) => (
            <rect
              key={`fret-${i + 1}`}
              x={x - FRET_WIDTH / 2}
              y={boardTopY}
              width={FRET_WIDTH}
              height={boardHeight}
              fill="url(#metal)"
              stroke="#6a6a6a"
              strokeWidth={0.6}
              opacity={0.98}
            />
          ))}

          {/* inlays */}
          {inlayStyle !== 'none' && inlayFrets.map((n) => {
          const xL = fretXs[n - 1]
          const xR = fretXs[n]
          const xMid = (xL + xR) / 2
          const isDouble = n === 12 || (n === 24 && frets >= 24)
          const bottomY = Math.max(...stringYs)
          const topY = Math.min(...stringYs)
          const centerY = (topY + bottomY) / 2
          const inlayFill = theme === 'maple' ? '#333' : '#dcd7c9'
          if (inlayStyle === 'dot') {
            const dotR = 8
            const edgeMargin = Math.max(dotR + 3, paddingY * 0.6)
            const yTopEdge = boardTopY + paddingY + edgeMargin
            const yBottomEdge = boardBottomY - paddingY - edgeMargin
            return (
              <g key={`inlay-${n}`}>
                {isDouble ? (
                  <>
                    <circle cx={xMid} cy={yTopEdge} r={dotR} fill={inlayFill} opacity={0.95} />
                    <circle cx={xMid} cy={yBottomEdge} r={dotR} fill={inlayFill} opacity={0.95} />
                  </>
                ) : (
                  <circle cx={xMid} cy={centerY} r={dotR} fill={inlayFill} opacity={0.9} />
                )}
              </g>
            )
          }
          // block style: single pearl block, slightly narrower horizontally and taller vertically (12/24 also single)
          const vSpan = bottomY - topY
          const vPad = Math.max(4, vSpan * 0.06) // smaller pad => taller block
          const blockH = Math.max(22, vSpan - vPad * 2)
          const y = centerY - blockH / 2
          const hSpan = xR - xL
          const hPad = Math.max(4, hSpan * 0.16) // slightly larger pad => slightly narrower block
          const blockW = Math.max(10, hSpan - hPad * 2)
          const x = xL + hPad
          const ry = 4
          return (
            <g key={`inlay-${n}`}>
              <rect x={x} y={y} width={blockW} height={blockH} rx={ry} ry={ry} fill="url(#pearl)" opacity={0.95} stroke="rgba(255,255,255,0.35)" strokeWidth={0.6} />
            </g>
          )
          })}

          {/* side dots: bottom edge inside binding, otherwise on a side rail below the board */}
          {sideDots && (
            <>
              {binding ? (
                inlayFrets.map((n) => {
                  const xL = fretXs[n - 1]
                  const xR = fretXs[n]
                  const xMid = (xL + xR) / 2
                  const yDot = boardBottomY + (bindingThickness / 2)
                  const isDouble = n === 12 || (n === 24 && frets >= 24)
                  const r = 3
                  return (
                    <g key={`sidedot-bind-${n}`}>
                      {isDouble ? (
                        <>
                          <circle cx={xMid - 6} cy={yDot} r={r} fill="#9c9582" opacity={0.95} />
                          <circle cx={xMid + 6} cy={yDot} r={r} fill="#9c9582" opacity={0.95} />
                        </>
                      ) : (
                        <circle cx={xMid} cy={yDot} r={r} fill="#9c9582" opacity={0.95} />
                      )}
                    </g>
                  )
                })
              ) : (
                <>
                  <rect x={0} y={boardBottomY} width={width} height={sideRailHeight} fill={railFill} opacity={0.98} />
                  <line x1={0} y1={boardBottomY} x2={width} y2={boardBottomY} stroke={railStroke} strokeWidth={1} opacity={0.9} />
                  {/* nut side extension */}
                  <rect x={0} y={boardBottomY} width={nutWidth} height={sideRailHeight} fill={nutSideFill} opacity={0.98} />
                  {inlayFrets.map((n) => {
                    const xL = fretXs[n - 1]
                    const xR = fretXs[n]
                    const xMid = (xL + xR) / 2
                    const yDot = boardBottomY + (sideRailHeight / 2)
                    const isDouble = n === 12 || (n === 24 && frets >= 24)
                    const r = 3
                    return (
                      <g key={`sidedot-rail-${n}`}>
                        {isDouble ? (
                          <>
                            <circle cx={xMid - 6} cy={yDot} r={r} fill="#dcd7c9" opacity={0.9} />
                            <circle cx={xMid + 6} cy={yDot} r={r} fill="#dcd7c9" opacity={0.9} />
                          </>
                        ) : (
                          <circle cx={xMid} cy={yDot} r={r} fill="#dcd7c9" opacity={0.9} />
                        )}
                      </g>
                    )
                  })}
                </>
              )}
            </>
          )}

        {/* strings */}
          {stringYs.map((y, i) => {
          const gauge = 4 + (stringYs.length - 1 - i) * 1.2 // thicker for lower strings (bottom)
          const highlight = '#e7f0f6'
          return (
            <g key={`string-${i}`}>
              <rect
                x={0}
                y={y - gauge / 2}
                width={width}
                height={gauge}
                fill="url(#rw)"
                opacity={0.95}
                style={{ filter: 'drop-shadow(0px 1px 0px rgba(0,0,0,0.35))' }}
              />
              <line
                x1={0}
                y1={y}
                x2={width}
                y2={y}
                stroke={highlight}
                strokeWidth={Math.max(1, gauge - 3)}
                opacity={0.5}
              />
            </g>
          )
          })}

        {/* hover indicator only; no target hint */}

        {/* hover highlight: full cell area for the hovered string × fret */}
          {hover && (
          (() => {
            const yCenter = stringYs[hover.stringIndex]
            const h = heightPerString * 0.9
            const y = yCenter - h / 2
          if (hover.fret === 0) {
              // open: entire open click zone
              const x0 = 0
              const firstFretX = fretXs[1] ?? (nutWidth + 60)
              const openGrace = Math.min(24, (firstFretX - nutWidth) * 0.25)
              const x1 = nutWidth + openPad + openGrace
              const w = x1 - x0
              return <rect x={x0} y={y} width={w} height={h} rx={6} ry={6} fill="rgba(0,0,0,0.20)" />
            } else {
              let x0 = fretXs[hover.fret - 1]
              let x1 = fretXs[hover.fret]
              // mirror hit-test padding to avoid overlapping metal frets
              const pad = Math.max(3, Math.ceil(FRET_WIDTH / 2) + 1)
              if (x1 - x0 > pad * 2) { x0 += pad; x1 -= pad }
              // avoid overlap with expanded open region on 1st fret
              if (hover.fret === 1) {
                const firstFretX = fretXs[1] ?? (nutWidth + 60)
                const openGrace = Math.min(24, (firstFretX - nutWidth) * 0.25)
                const openRight = nutWidth + openPad + openGrace
                if (openRight > x0) x0 = Math.min(x1 - 2, openRight)
              }
              const w = Math.max(2, x1 - x0)
              return <rect x={x0} y={y} width={w} height={h} rx={6} ry={6} fill="rgba(0,0,0,0.20)" />
            }
          })()
          )}
        </g>
    </svg>
  )
}

function StaffNote({ midi }: { midi: number }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!ref.current) return
    ref.current.innerHTML = ''
    const width = 240
    const height = 280
    const renderer = new Renderer(ref.current, Renderer.Backends.SVG)
    renderer.resize(width, height)
    const context = renderer.getContext()
    // draw staff and notes in white on dark background
    // (VexFlow uses current context stroke/fill styles)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(context as any).setFillStyle?.('#ffffff')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(context as any).setStrokeStyle?.('#ffffff')
    // Always-rendered vertical position (fixed), keep consistent across problems
    const writtenMidi = midi + 12 // 8vb notation (bass clef standard)
    const { key, acc, oct } = midiToVexKey(writtenMidi)
    const staveY = 50
    const stave = new Stave(16, staveY, width - 32)
    stave.addClef('bass')
    stave.setContext(context).draw()
    // Stem direction rule: from E3 (written) and above, force stems downward
    // writtenMidi already includes +12 (8vb); E3 (written) MIDI = 52
    const stemDir = (writtenMidi >= 52) ? -1 : 1
    const note = new StaveNote({ clef: 'bass', keys: [`${key}/${oct}`], duration: 'q' } as any)
    // apply stem direction across VexFlow versions
    ;(note as any).setStemDirection?.(stemDir)
    if (!(note as any).setStemDirection) { (note as any).stem_direction = stemDir }
    if (acc) note.addModifier(new Accidental(acc), 0)
    const voice = new Voice({ numBeats: 1, beatValue: 4 })
    voice.addTickables([note])
    new Formatter().joinVoices([voice]).format([voice], Math.max(120, width - 80))
    voice.draw(context, stave)

    // Allow CSS to control final rendered size: remove fixed w/h attributes
    const svgEl = ref.current.querySelector('svg') as SVGSVGElement | null
    if (svgEl) {
      svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`)
      svgEl.removeAttribute('width')
      svgEl.removeAttribute('height')
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      svgEl.style.width = 'auto'
      svgEl.style.height = 'auto'
    }
  }, [midi])
  return <div className="staff-problem" ref={ref} aria-label={`midi-${midi}`} />
}

function midiToVexKey(midi: number): { key: string; oct: number; acc: '' | '#' | 'b' } {
  const pc = midi % 12
  const octave = Math.floor(midi / 12) - 1
  // sharps mapping by default
  const map: Record<number, { key: string; acc: '' | '#' | 'b' }> = {
    0: { key: 'c', acc: '' },
    1: { key: 'c', acc: '#' },
    2: { key: 'd', acc: '' },
    3: { key: 'd', acc: '#' },
    4: { key: 'e', acc: '' },
    5: { key: 'f', acc: '' },
    6: { key: 'f', acc: '#' },
    7: { key: 'g', acc: '' },
    8: { key: 'g', acc: '#' },
    9: { key: 'a', acc: '' },
    10: { key: 'a', acc: '#' },
    11: { key: 'b', acc: '' },
  }
  const { key, acc } = map[pc]
  return { key, acc, oct: octave }
}
