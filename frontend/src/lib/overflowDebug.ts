/**
 * Temporary mobile horizontal-overflow detector (Wave 6 Polish — diagnosing the
 * recurring Portfolio reveal-time h-scroll that survived an <main> clip, a
 * flex-col card stack, AND a root `html { overflow-x: clip }`).
 *
 * INERT by default. Activates ONLY when the URL has `?ofx=1`. When active it
 * scans the DOM ~once a second (and after every click), outlines any element
 * whose box extends past the viewport's left/right edge, and prints the worst
 * offenders to a fixed banner — flagging `position: fixed`/`sticky` ones in
 * green (those escape `overflow: clip` and are the prime suspects).
 *
 * Usage: open `…/portfolio?ofx=1`, reveal a balance, read/screenshot the banner.
 * Remove this file + its main.ts call once the culprit is fixed.
 */
export function installOverflowDebug(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  try {
    if (new URLSearchParams(window.location.search).get('ofx') !== '1') return
  } catch {
    return
  }

  const banner = document.createElement('div')
  banner.setAttribute('data-ofx-banner', '')
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'width:100%', 'max-height:46vh',
    'overflow:auto', 'z-index:2147483647', 'background:rgba(150,0,0,.93)',
    'color:#fff', 'font:11px/1.35 ui-monospace,SFMono-Regular,monospace',
    'padding:6px 8px', 'white-space:pre-wrap', 'pointer-events:none',
    'box-sizing:border-box',
  ].join(';')

  function scan(): void {
    if (!banner.isConnected) document.body.appendChild(banner)
    const docEl = document.documentElement
    const vw = docEl.clientWidth
    const offenders: Array<{ el: HTMLElement; left: number; right: number; w: number; fixed: boolean }> = []

    document.body.querySelectorAll<HTMLElement>('*').forEach((el) => {
      if (el.hasAttribute('data-ofx-banner')) return
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return
      if (r.right > vw + 1 || r.left < -1) {
        const pos = getComputedStyle(el).position
        offenders.push({ el, left: r.left, right: r.right, w: r.width, fixed: pos === 'fixed' || pos === 'sticky' })
      }
    })
    // Worst horizontal spill first.
    offenders.sort((a, b) => Math.max(b.right - vw, -b.left) - Math.max(a.right - vw, -a.left))

    const vv = window.visualViewport
    const lines: string[] = [
      `vw=${vw} docScrollW=${docEl.scrollWidth} bodyScrollW=${document.body.scrollWidth}`
      + (vv ? ` vvScale=${vv.scale.toFixed(2)}` : ''),
      `overflowers=${offenders.length} (green=FIXED/STICKY → the suspect)`,
    ]
    offenders.slice(0, 10).forEach((o) => {
      const e = o.el
      const tid = e.getAttribute('data-testid')
      const cls = typeof e.className === 'string'
        ? '.' + e.className.trim().split(/\s+/).slice(0, 5).join('.')
        : ''
      e.style.outline = o.fixed ? '2px solid #22ff22' : '2px solid #22ffff'
      lines.push(
        `${o.fixed ? 'FIXED ' : ''}<${e.tagName.toLowerCase()}>${tid ? `[${tid}]` : ''} ${cls.slice(0, 70)}`
        + ` L=${Math.round(o.left)} R=${Math.round(o.right)} W=${Math.round(o.w)}`,
      )
    })
    banner.textContent = lines.join('\n')
  }

  const start = () => {
    document.body.appendChild(banner)
    scan()
    window.setInterval(scan, 800)
    window.addEventListener('click', () => window.setTimeout(scan, 350), true)
  }
  if (document.body) start()
  else window.addEventListener('DOMContentLoaded', start)
}
