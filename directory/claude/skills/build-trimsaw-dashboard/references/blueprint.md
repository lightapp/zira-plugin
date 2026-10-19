# Trimsaw validation dashboard blueprint

Use this blueprint per selected source. All metric aliases below are placeholders resolved from
context: `Q` = quantity, `PRE` = average precut, `POST` = average postcut, `TARGET` = recorded stop,
`NC` = No Cut. In formulas replace them with actual `m<ID>` aliases. Never persist these symbols
or infer IDs from another source. Verify quantities represent boards, not rows.

Read [native widget settings](../../build-dashboard/references/native-widgets.md),
[analysis patterns](../../build-dashboard/references/analysis-patterns.md) and
[AI summary settings](../../build-dashboard/references/ai-summary.md) when authoring.
Use stable unique local keys and series IDs; prefix widget names with the source name when there
is more than one source. Keep summaries near their evidence, headings short and tables wide.

## Source section

| Widget | Native type and calculation | Check |
| --- | --- | --- |
| Source heading | `header`; short source name, original/raw interpretation | Correct source link/name |
| Boards recorded | KPI, SUM(Q) | Raw board sum |
| Boards cut | KPI, SUM(Q) where outcome is Cut | Raw cut sum |
| Uncut share | KPI, 100 × uncut boards / all boards | Same denominator; empty is 0 with zero boards shown |
| Outcome mix | Pie, SUM(Q) grouped by Cut / Uncut / Unknown | Parts reconcile to total |
| Boards by recorded stop | Bar/column, SUM(Q) by original TARGET | No merging close labels |
| Incoming lengths | Column, half-unit PRE bins, cut/uncut/unknown series | Weighted histogram sum; missing PRE visible |
| Measured cut lengths | Column, fine POST bins (normally 0.1 recorded unit), split by TARGET, cut rows | Raw cut distribution and missing POST coverage |
| Why recorded uncut | Bar/pie, SUM(Q) by uncut-reason dimension | Uncut categories reconcile |
| Stop summary | KPI table by TARGET: boards, cut, uncut, valid-measurement count and weighted mean cut POST | Numerator/denominator share valid population |
| Production over time | Time series of cut/uncut/unknown board sums | Site timezone and day boundary |
| Readings | `readings`; source, time, Q, TARGET, PRE, POST, NC; edit mode off | Inspect source records |
| Recorded-stop filter | `filter`, inactive quick choices for sampled original labels | Targets only this section's analytics and readings |
| AI summary | `aiSummary`, relevant analytics from this section | Actual generated answer, correct source/range |

These are 14 widgets including the AI summary. Up to three neighboring pairs can add two widgets
each within the 20-widget batch limit. Rank observed pairs by quantity and disclose omitted pairs.
For requested extra pairs use a separate fresh batch; do not drop them silently. Existing section
filters do not automatically target later widgets: rebuild the filter's complete target settings
with the relevant same-batch targets, or clearly keep the extra comparison section independent.
Do not guess unsampled stop values to fill a filter. An empty stop list can omit the filter with an
explicit note; the unfiltered charts still cover newly appearing recorded labels.

## Derived dimensions and measures

- **Outcome:** recognize the actual NC encodings. Typical readings use boolean true/false in
  short ranges and `t`/`f` in weekly files; handle both explicitly. Only map 0/1 or string
  true/false if the sample confirms them. Unknown/missing flags stay Unknown. Equal PRE/POST
  is not a substitute for the No Cut flag.
- **Length bins:** `roundTo(PRE, 0.5)` and `roundTo(POST, 0.1)` on valid measurements, weighted
  with SUM(Q). Add a visible missing category or companion count; don't hide omitted rows behind
  a total. When using a text bin to include “Unknown,” order deliberately rather than assuming
  lexical labels sort numerically. These are distributions of row means weighted by boards,
  not reconstructed individual-board measurements.
- **Uncut reason:** for recorded uncut rows distinguish missing length, no recorded positive
  target, within tolerance, longer than target and shorter than target. State the tolerance in
  the description, normally 0.5 **recorded unit** after inspecting the unit/spacing. Never use a
  tolerance spanning close stops without disclosure. Keep raw precut and original targets.
- **Weighted cut mean:** define raw row fields for valid cut quantity and POST × that quantity;
  SUM(product) / SUM(valid quantity), retaining the valid quantity alongside it. Reject missing
  POST from both parts. State empty-population behavior; zero fallback is not a measured length.
  Native analytics does not provide a weighted median/percentile: do not rename the mean.

Every analytical widget includes `meter_id = <selected source>` in its own filters, including
denominators and derived-weight sums. Readings points to that same source. Duplicate metric IDs
across cameras do not make their rows interchangeable. No cross-source averaging, shared physical
stop assumption or unit conversion is implied by selecting multiple sources.

## Neighboring labels

Use original labels observed 0.5 or 1 recorded unit apart. The local validation skill's read-only
`check` supplies `neighbors` and sample counts when applicable; retain its omitted coverage.
For each selected pair, add a time chart of per-label cut/uncut board counts (and pair share when
useful), plus a POST histogram split by recorded label for the same selected range and cut rows.
Keep sequential relabels and sparse samples distinct from simultaneous production. Peak overlap
can motivate investigation, but does not prove the intended physical stop or a misclassification
rate. The user/operator, production log or corresponding video establishes intent.

## AI summary instruction

Adapt this intent to the selected metrics and confirmed units, rather than embedding sample results:

> Summarize this source's selected production range from the supplied widgets. Report total boards,
> cut/uncut/unknown shares, main incoming lengths and recorded stops, and explain the observed
> uncut categories. Compare weighted measured cut lengths with original labels without calling
> differences proven calibration failures. Discuss neighboring labels only when their sample and
> time evidence is present; distinguish sparse or sequential activity from simultaneous activity.
> State missing data and unsupported comparisons. Lengths use the confirmed unit stated here.
> Do not infer current inventory, intended physical stop or a measured error rate. End with a few
> checks the operator can perform. If the range is empty, say so instead of inventing values.

Select only relevant analytical widgets. Plain bullets and a short table are useful defaults.
The prompt is a configuration, not guaranteed output: inspect a generated answer separately.
