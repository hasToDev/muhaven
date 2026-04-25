/**
 * @deprecated Phase 7.5 (`MHUSD_WRAPPER_PLAN.md` + ADR-041) renamed this
 *             service to `LegacyPusdcService`. New code should import from
 *             `MuHavenStableService` for the modern (mhUSDC) hot path or
 *             from `LegacyPusdcService` for the wrap-entry readouts on
 *             legacy PUSDC. This file remains as a re-export shim so
 *             Wave 3 call sites compile during the cutover.
 */

export {
  balanceOf,
  confidentialBalanceOf,
  isOperator,
  setOperator,
} from './LegacyPusdcService'
