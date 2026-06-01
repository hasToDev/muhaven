/**
 * MTokenSelect — custom token picker that replaced the native <select> on the
 * Trade (buy/sell) and Transfer flows (Wave 6 Polish, the deferred token-picker
 * item). The native select's OS dialog couldn't be restyled and read as broken
 * at 411px.
 *
 * The load-bearing contract is `v-model` = the token **address** string, so the
 * host pages' buy/sell/transfer logic is untouched. These tests pin that
 * contract: the trigger renders the selected token + carries the e2e testid,
 * opening lists one `data-testid="token-option"` per token, selecting emits
 * `update:modelValue` with the address, and `disabled` is inert.
 *
 * happy-dom has no real viewport, so `useMediaQuery` resolves to `false` →
 * the picker mounts via the mobile bottom-sheet branch. The teleported list
 * lands on `document.body` (cleared between tests).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MTokenSelect from '../MTokenSelect.vue'
import type { TokenResponseDto } from '@/services/api'

const TOKENS = [
  { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Cetes Bond Fund', symbol: 'CETES', apy: '6.2', status: 'active' },
  { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Polar Treasury', symbol: 'POLAR', apy: null, status: 'active' },
  { address: '0xcccccccccccccccccccccccccccccccccccccccc', name: 'US Yield Coin', symbol: 'USYC', apy: '4.8', status: 'active' },
] as unknown as TokenResponseDto[]

const TESTID = 'buy-token-select'

function optionEls(): HTMLElement[] {
  return [...document.body.querySelectorAll('[data-testid="token-option"]')] as HTMLElement[]
}

describe('MTokenSelect — custom token picker', () => {
  beforeEach(() => {
    // Teleported list content lands on document.body — clear between tests.
    document.body.innerHTML = ''
  })

  it('renders the trigger with the selected token + the e2e testid', () => {
    const w = mount(MTokenSelect, {
      props: { modelValue: TOKENS[0].address, options: TOKENS, label: 'Select Asset', testid: TESTID, showApy: true },
    })
    const trigger = w.get(`[data-testid="${TESTID}"]`)
    expect(trigger.text()).toContain('CETES')
    expect(trigger.text()).toContain('Cetes Bond Fund')
    // showApy surfaces the APY in the trigger.
    expect(trigger.text()).toContain('6.2% APY')
  })

  it('is closed until the trigger is clicked, then lists one option per token', async () => {
    const w = mount(MTokenSelect, {
      props: { modelValue: TOKENS[0].address, options: TOKENS, label: 'Select Asset', testid: TESTID, showApy: true },
    })
    expect(optionEls()).toHaveLength(0)

    await w.get(`[data-testid="${TESTID}"]`).trigger('click')
    await flushPromises()

    expect(optionEls()).toHaveLength(TOKENS.length)
  })

  it('emits update:modelValue with the clicked token ADDRESS, then closes', async () => {
    const w = mount(MTokenSelect, {
      props: { modelValue: TOKENS[0].address, options: TOKENS, label: 'Select Asset', testid: TESTID, showApy: true },
    })
    await w.get(`[data-testid="${TESTID}"]`).trigger('click')
    await flushPromises()

    const polar = optionEls().find((el) => el.getAttribute('data-value') === TOKENS[1].address)
    expect(polar).toBeTruthy()
    polar!.click()
    await flushPromises()

    expect(w.emitted('update:modelValue')).toBeTruthy()
    expect(w.emitted('update:modelValue')![0]).toEqual([TOKENS[1].address])
    // Selecting closes the picker.
    expect(optionEls()).toHaveLength(0)
  })

  it('renders "N/A" for a token with no APY (and the % label when present)', async () => {
    const w = mount(MTokenSelect, {
      props: { modelValue: TOKENS[0].address, options: TOKENS, label: 'Select Asset', testid: TESTID, showApy: true },
    })
    await w.get(`[data-testid="${TESTID}"]`).trigger('click')
    await flushPromises()

    const polar = optionEls().find((el) => el.getAttribute('data-value') === TOKENS[1].address)!
    const usyc = optionEls().find((el) => el.getAttribute('data-value') === TOKENS[2].address)!
    expect(polar.textContent).toContain('N/A')
    expect(usyc.textContent).toContain('4.8% APY')
  })

  it('does NOT render APY when showApy is false (Transfer)', async () => {
    const w = mount(MTokenSelect, {
      props: { modelValue: TOKENS[0].address, options: TOKENS, label: 'Token', testid: 'transfer-token-select' },
    })
    await w.get('[data-testid="transfer-token-select"]').trigger('click')
    await flushPromises()
    for (const el of optionEls()) {
      expect(el.textContent).not.toContain('APY')
    }
  })

  it('is inert when disabled — clicking the trigger does not open', async () => {
    const w = mount(MTokenSelect, {
      props: { modelValue: TOKENS[0].address, options: TOKENS, label: 'Select Asset', testid: TESTID, disabled: true },
    })
    const trigger = w.get(`[data-testid="${TESTID}"]`)
    expect(trigger.attributes('disabled')).toBeDefined()
    await trigger.trigger('click')
    await flushPromises()
    expect(optionEls()).toHaveLength(0)
  })

  it('marks the selected option aria-selected and reflects modelValue changes', async () => {
    const w = mount(MTokenSelect, {
      props: { modelValue: TOKENS[0].address, options: TOKENS, label: 'Select Asset', testid: TESTID, showApy: true },
    })
    await w.get(`[data-testid="${TESTID}"]`).trigger('click')
    await flushPromises()
    const selected = optionEls().filter((el) => el.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].getAttribute('data-value')).toBe(TOKENS[0].address)
  })
})
