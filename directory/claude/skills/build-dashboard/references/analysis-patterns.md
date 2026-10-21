# From a question to a defensible widget

Start with the requested decision, not a fixed catalog of suggestions. For each widget define its population, measure, grouping, weight, time basis and an independent expected check. Keep ambiguous semantics visible and resolve them from data or the user before saving a misleading label.

## Patterns beyond ready-made suggestions

| User question | Native design | Verification |
| --- | --- | --- |
| How many items? | KPI with SUM(quantity) | Compare raw quantity sum; COUNT(rows) is usually different |
| What fraction failed? | Filtered numerator / common denominator with `customAgg` | Categories reconcile to total; denominator is explicit |
| What sizes arrive? | Row-level `roundTo` bin, grouped SUM(quantity) | Bin sum equals included quantity, including unknown/missing bucket |
| Where do measurements differ from targets? | Text band labels of the signed difference, grouped by target with one series per band (percent stacking) | Test just below/on/above boundaries and keep unknowns; a numeric difference dimension that can be negative renders nothing |
| What changed over time? | Time series with fixed or inherited resolution | Match site timezone, production day start, and raw range |
| Are nearby categories overlapping? | Per-category weighted distributions plus simultaneous count/share timeline | Do not infer intended physical category from recorded label; put the combined series first in a split histogram |
| What is a weighted mean? | Derived `quantity × value`, hidden sums, custom quotient | Use the same non-null population in numerator and denominator |
| Can I investigate a spike? | Shared filter plus readings table | Inspect source rows, filter targets and all key totals together |

Don't independently average already averaged rows when their quantities differ. SUM(value × quantity) / SUM(quantity) weights row means correctly; it does not reconstruct individual observations or their percentiles. Rates per hour also need a deliberate elapsed/scheduled/working-hours denominator, not simply an average of bucket rates.

Before applying a correction, establish its provenance, whether it is an estimate and whether the user authorized changing the displayed interpretation. Never silently fit a factor to make the graph match expected results. Preserve raw charts beside corrected ones when comparison is the purpose. A dimension correction belongs in `derivedMetrics`; `customAgg` cannot rename or re-bin categories after grouping.

## Trimsaw validation as native widgets

Read validate-trimsaw-sizes' report interpretation when the user asks to mirror that report. Obtain a bounded window after relevant calibration/label changes. The reference report's `windows` and `check` can supply independent expected totals and distributions; do not copy customer results into the skill or package.

Discover the actual metric IDs and populated values for Units, Target Length, Average Precut Length, Average Postcut Length and No Cut. Verify the No Cut flag **on this source and window**. Older web guidance sometimes assumes it is missing/inverted and uses equal pre/post as a fallback; equality can occur in a recorded cut and is not automatically equivalent. Missing flags stay unknown. Schema unit labels can be stale; label recorded units and disclose uncertainty instead of guessing inches/feet or converting them.

A useful dashboard includes:

- Overall board count, cut count, uncut share, and an outcome composition chart.
- Counts by the original recorded stop; keep close neighboring labels separate.
- Incoming length histogram (half-unit bins): all boards first, uncut overlaid.
- Measured postcut histogram (cut rows only, fine bins) as one series, and cut boards per stop in
  distance bands (within ±0.25 first, then short/long by 0.25–0.5 and over 0.5, percent-stacked).
  A per-stop series first hides every other stop's bins.
- Uncut split: not at a stop / near stop size / longer / shorter. Declare tolerance and whether raw or corrected precut is used. Missing lengths are a separate category, not “at size.”
- Stop summary table with board counts, cut/uncut counts and weighted mean cut length.
- Count and share timelines for neighboring labels, plus their measured distributions on the same time window.
- Shared recorded-stop controls and a read-only table with time, Units, stop, pre/post, and No Cut.

For measured length `mLEN`, quantity `mQ` and target `mTARGET`, a derived `roundTo(mLEN, 0.5)` is a weighted histogram dimension; SUM(quantity) is its y value. A signed difference is `mLEN - mTARGET`; use it inside text band labels, not as a numeric dimension. A percentage uses hidden whole/filtered sums and `100 * filtered / whole` with a documented empty-population policy.

Order multi-series column/bar charts by the [first-series rule](native-widgets.md#column-and-bar-categories-come-from-the-first-visible-series). An AI Insights answer sees KPI values only, so it cannot judge per-stop distributions; see [AI summary](ai-summary.md#what-the-generated-answer-can-see).

Native limits must remain explicit: the current analytics operator set has no median or weighted percentiles, no automatic change-point detection and no automatic relabel reconciliation. Native histograms of row means weighted by Units approximate distributions of board lengths; they are not raw per-board measurements. Don't label a weighted mean “median,” a recorded label “intended stop,” or inferred spillover an error rate. Link or retain the local report when those analyses are essential instead of fabricating equivalents.

## Acceptance loop

1. Fetch/retain a fixed raw-data range and record offset, production-day boundary and source IDs.
2. Preview the complete widget spec; inspect formulas, source membership and all responsive layouts.
3. Save once. Confirm server read-back, including derived fields, custom expressions and filter target IDs.
4. Open the dashboard. Check render errors, blank series, labels, readable scales, legends and responsive layout. Check that every expected category appears: a column/bar chart draws only the categories of its first visible series. Resolve each preview `first_series_categories` warning here.
5. Match at least one total, ratio, weighted mean and histogram bin sum to independent raw queries for identical bounds/filters. Check both a populated and an empty/narrowed range.
6. Exercise shared filters; verify only intended widgets change, clear selection, and confirm restored totals.
7. Treat mismatches as bugs: investigate timezone, filters, null handling, quantity weights and stale data before changing the formula to fit a number. Save a correction only after a fresh preview.

Keep saved/rendered/numerically-verified status separate. If an API is unavailable, preserve the spec and report the blocked route. Don't claim a production test passed based only on fixture tests or an empty dashboard.
