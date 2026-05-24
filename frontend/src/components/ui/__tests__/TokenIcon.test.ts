/**
 * Wave 5 — TokenIcon renders the baked same-origin icon and falls back to
 * a monogram (no broken-image glyph) when the icon is absent or fails to
 * load. The generated manifest is mocked for determinism.
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@/data/tokenIcons.generated', () => ({
  TOKEN_ICON_MANIFEST: {
    USYC: '/token-icons/USYC.png',
    BUIDL: '/token-icons/BUIDL.png',
  },
}))

import TokenIcon from '@/components/ui/TokenIcon.vue'

const IMG = '[data-testid="token-icon-image"]'
const MONO = '[data-testid="token-icon-monogram"]'

describe('TokenIcon', () => {
  it('renders the baked icon for a known ticker', () => {
    const w = mount(TokenIcon, { props: { ticker: 'USYC' } })
    const img = w.find(IMG)
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/token-icons/USYC.png')
    expect(img.attributes('alt')).toBe('') // decorative
    expect(w.find(MONO).exists()).toBe(false)
  })

  it('falls back to a monogram when the image fails to load (@error)', async () => {
    const w = mount(TokenIcon, { props: { ticker: 'USYC' } })
    await w.find(IMG).trigger('error')
    expect(w.find(IMG).exists()).toBe(false)
    const mono = w.find(MONO)
    expect(mono.exists()).toBe(true)
    expect(mono.text()).toBe('U')
    expect(mono.attributes('aria-hidden')).toBe('true')
  })

  it('renders a monogram directly for an unbaked ticker (no broken image)', () => {
    const w = mount(TokenIcon, { props: { ticker: 'NOPE' } })
    expect(w.find(IMG).exists()).toBe(false)
    expect(w.find(MONO).text()).toBe('N')
  })

  it('applies the hero variant shape', () => {
    const w = mount(TokenIcon, { props: { ticker: 'USYC', variant: 'hero' } })
    expect(w.find(IMG).classes()).toContain('rounded-2xl')
  })

  it('applies the card variant shape by default', () => {
    const w = mount(TokenIcon, { props: { ticker: 'USYC' } })
    expect(w.find(IMG).classes()).toContain('rounded-full')
  })

  it('re-attempts the icon after a ticker change resets the load failure', async () => {
    const w = mount(TokenIcon, { props: { ticker: 'USYC' } })
    await w.find(IMG).trigger('error')
    expect(w.find(MONO).exists()).toBe(true)
    // Detail-page navigation USYC → BUIDL reuses the instance; the new
    // ticker must clear the stale failure and show its icon.
    await w.setProps({ ticker: 'BUIDL' })
    const img = w.find(IMG)
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/token-icons/BUIDL.png')
  })
})
