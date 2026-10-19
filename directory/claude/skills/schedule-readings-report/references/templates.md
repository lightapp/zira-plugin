# Scheduled report templates

`plan` classifies each data source, then offers only the blocks whose metrics its group has. Zira metric IDs are shared across data sources, so templates use them directly.

| Kind | Recognized by | Default blocks | Optional |
| --- | --- | --- | --- |
| Pallet QA | Device type `PALLET_QA`, source type "Pallet Inspector", or Disposition (57834) / Rule Name (58310) | Pallets per day and hour, fail rate (pallet-weighted), fails by rule, running share, stop minutes by reason | Fails by rule per day, protruding nails per fail, shifts |
| Trimsaw | Device type `TRIM_SAW`, or Precut/Postcut (40072/40073) / Target Length (48169) | Boards per day and hour, average yield, cut length spread, cut length by target, running share, stop reasons | No-cut share, defective boards, shifts |
| Bandsaw | Device type `BAND_SAW`, or Length + Width (77/76) / Pallet Size (48735) | Units per day and hour, area, top pallet sizes, running share, stop reasons | Length and width per day, shifts |
| Custom / form | Anything else; one group per source | Units, readings or (forms) submissions per day, daily averages of up to four numeric metrics, breakdowns by the first two list metrics | Hourly, other list metrics, shifts |

Common metrics: Units 86, Status 2693, Duration 81 (minutes), Event 53315 (stop reason), Shift 3411. Running share is the share of reported minutes not in `Stop`. Fail rate is failed pallets ÷ pallets (`share` op on Units), not the share of readings: one Pass reading can carry many pallets.

## Digest and flags

Each key number marked for comparison (output, fail rate, yield, area, no-cut share, running share) is computed for the span and the span before it. Its `direction` says whether it moved the good way.

| Flag | Default | Threshold key |
| --- | --- | --- |
| Pallet QA day with fail rate above the limit (days with at least 50 pallets) | 8% | `failRatePct`, `minUnitsForRate` |
| Day with stops longer than the limit and no reason entered ("Pending Reason") | 60 min | `pendingStopMin` |
| Source quiet / offline | 30 min / 1 day | `quietMin`, `offlineMin` |

A problem on three or more days of one source is collapsed into one line. A form with no recent entries says "no form submissions", not offline.
