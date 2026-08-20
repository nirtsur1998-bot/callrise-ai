import { NoiseCancellationCard } from '@renderer/features/audio/NoiseCancellationCard'
import { Tier1SettingsCard, Tier1DiagnosticsCard } from '@renderer/features/audio/Tier1SettingsCard'

// Both cards self-gate by platform (NoiseCancellationCard: isMac,
// Tier1SettingsCard: isWindows) and return null on the wrong one — the
// established pattern already used by NoiseCancellationCard itself, so this
// file needs no platform logic of its own and NoiseCancellationCard needed
// ZERO changes for Tier 1 to exist. Diff it to confirm, don't assume.
export function AudioSection(): React.JSX.Element {
  return (
    <>
      <NoiseCancellationCard />
      <Tier1SettingsCard />
      <Tier1DiagnosticsCard />
    </>
  )
}
