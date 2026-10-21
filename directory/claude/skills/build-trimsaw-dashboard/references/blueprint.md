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
| Boards by recorded stop | Bar, SUM(Q) by original TARGET: "All boards" first, "Uncut" overlaid with `stacking:"3"` | Every recorded label appears; no merging close labels |
| Incoming lengths | Column, half-unit PRE bins: "All boards" first, "Uncut" overlaid with `stacking:"3"` | Weighted histogram sum; missing PRE visible; remainder described as cut or unknown |
| Measured cut lengths | Column, fine POST bins (normally 0.1 recorded unit), cut rows, **one series** | Raw cut distribution and missing POST coverage |
| Cut boards around their stop size | Bar by original TARGET, one series per distance band, `stacking:"2"` (percent); see below | Every stop with cut rows appears; band shares match raw rows |
| Why recorded uncut | Bar/pie, SUM(Q) by uncut-reason dimension | Uncut categories reconcile |
| Stop summary | KPI table by TARGET: boards, cut, uncut, valid-measurement count and weighted mean cut POST | Numerator/denominator share valid population |
| Production over time | Time series of cut/uncut/unknown board sums | Site timezone and day boundary |
| Readings | `readings`; source, time, Q, TARGET, PRE, POST, NC; edit mode off | Inspect source records |
| Recorded-stop filter | `filter`, inactive quick choices for sampled original labels | Targets only this section's analytics and readings |
| AI summary | `aiSummary`, the KPI widgets of this section | Actual generated answer, correct source/range, KPI values only |

These are 15 widgets including the AI summary. Up to two neighboring pairs can add two widgets
each within the 20-widget batch limit. Rank observed pairs by quantity and disclose omitted pairs.
For requested extra pairs use a separate fresh batch; do not drop them silently. Existing section
filters do not automatically target later widgets: rebuild the filter's complete target settings
with the relevant same-batch targets, or clearly keep the extra comparison section independent.
Do not guess unsampled stop values to fill a filter. An empty stop list can omit the filter with an
explicit note; the unfiltered charts still cover newly appearing recorded labels.

## Series order in column and bar charts

A column or bar chart draws only the categories where its **first visible series** has rows, and
a hidden helper (`hide:"off"`) does not count (seen in the browser on 2026-10-21). Splitting the
cut-length histogram into one series per stop, with the lowest stop first, shows only the bins
around that stop. A Cut series first drops every stop or bin that has only uncut boards. So:

- Count charts put a visible "All boards" series first (no series filter) and overlay "Uncut"
  with `stacking:"3"`. The visible remainder is cut or unknown; say so in the description.
- The fine POST histogram stays one series. Stop-level accuracy goes in the distance-band chart.
- The distance-band chart puts "Within 0.25" first because it is normally present at every stop.
  A stop with no cut boards within 0.25 disappears from it: check every stop in the browser.

`save` warns (`first_series_categories`) when a later series can have rows outside the first one.
Expect that warning on the distance-band chart and resolve it in the browser; fix the others.
See [native widget settings](../../build-dashboard/references/native-widgets.md#column-and-bar-categories-come-from-the-first-visible-series).

## Derived dimensions and measures

- **Outcome:** recognize the actual NC encodings. Typical readings use boolean true/false in
  short ranges and `t`/`f` in weekly files; handle both explicitly. Only map 0/1 or string
  true/false if the sample confirms them. Unknown/missing flags stay Unknown. Equal PRE/POST
  is not a substitute for the No Cut flag.
- **Length bins:** `roundTo(PRE, 0.5)` and `roundTo(POST, 0.1)` on valid measurements, weighted
  with SUM(Q). Add a visible missing category or companion count; don't hide omitted rows behind
  a total. When using a text bin to include “Unknown,” order deliberately rather than assuming
  lexical labels sort numerically. These are distributions of row means weighted by boards,
  not reconstructed individual-board measurements. Numeric bins are only for values that cannot
  be negative: a numeric `roundTo(POST - TARGET, 0.1)` dimension rendered no chart at all.
- **Distance from stop:** a `text` derived field of POST − TARGET in labelled bands, with order
  prefixes so the legend sorts by band:
  `TARGET <= 0 ? 'No stop' : ((POST - TARGET) < -0.5 ? '1 Short > 0.5' : ((POST - TARGET) < -0.25 ? '2 Short 0.25-0.5' : ((POST - TARGET) <= 0.25 ? '3 Within 0.25' : ((POST - TARGET) <= 0.5 ? '4 Long 0.25-0.5' : '5 Long > 0.5'))))`.
  Group by TARGET with five SUM(Q) series, `3 Within 0.25` first, then 1, 2, 4 and 5. Each series
  filters on its band (the derived field ID as `metric`, operator `1`, the label as value), on cut
  rows (NC) and on POST not null (operator `12`). Adapt band widths to the confirmed unit and stop
  spacing and state them in the description.
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
useful), plus a POST histogram of the pair for the same selected range and cut rows: both labels
first, one label overlaid with `stacking:"3"`, so the visible remainder is the other label.
Keep sequential relabels and sparse samples distinct from simultaneous production. Peak overlap
can motivate investigation, but does not prove the intended physical stop or a misclassification
rate. The user/operator, production log or corresponding video establishes intent.

## AI summary instruction

The generated answer receives KPI values only. Grouped charts and the stop table reach it as
placeholders, even after Generate Answer (checked on 2026-10-21), so it cannot judge per-stop
results. See [AI summary settings](../../build-dashboard/references/ai-summary.md#what-the-generated-answer-can-see).
Select this section's KPI widgets and adapt this intent to the selected metrics and confirmed
units, rather than embedding sample results:

> Summarize this source's selected production range from the supplied KPI values: total boards,
> boards cut and the uncut share. You receive KPI values only. Do not describe stop-level results,
> length distributions or uncut reasons; name the charts where the reader can check them
> ("Boards by recorded stop", "Cut boards around their stop size", "Why recorded uncut").
> State missing data and unsupported comparisons. Lengths use the confirmed unit stated here.
> Do not infer current inventory, intended physical stop or a measured error rate. End with a few
> checks the operator can perform. If the range is empty, say so instead of inventing values.

Plain bullets are a useful default. The prompt is a configuration, not guaranteed output: inspect
a generated answer separately.
