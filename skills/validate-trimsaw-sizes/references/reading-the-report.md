# Reading a trimsaw size report

How a bucket-path trimsaw camera reports boards, what each finding usually means and what it does
not prove. Use it to explain the report in plain words.

## What a reading row holds

The camera posts one row per minute for each combination of pre-cut bin, stop and cut state, with
the boards it counted (Units). Target Length is the stop the board sat against (0 when it matched
no stop). Postcut Length is the stop's nominal size for matched boards and the board's own length,
rounded to half a unit, for unmatched ones. Average Precut and Average Postcut are the camera's raw
measurements. No Cut is set when the board did not reach the saw line the camera derives.

## Findings and what they usually mean

| Finding | Usual meaning | What to suggest |
| --- | --- | --- |
| Cut boards at a stop form a tight peak away from the stop's size | Calibration offset at that stop, not noise | Check the stop's calibration value on the camera |
| Uncut share is high | Mostly boards already at the stop's size passing untouched; see the split | Read the split before calling it a problem |
| Uncut boards longer than their stop | The derived saw line sits past the real blade, so thin trims (under about 1–1.5 units) post as No Cut | Recheck the outer stops or the scale; after a fix the uncut share should drop |
| No Cut jumps right after a blade-line calibration, on stops that normally trim | The stored blade line may be a pile of equally trimmed stock, so trimmed boards post No Cut and pre-cut reads short by the trim | Recollect on the camera (the panel reports the blade line as found, doubtful or not yet) or turn its blade line off; confirm with a tape-measured board |
| Uncut boards well short of their stop | Short pieces pushed to a stop, or boards not against any stop | Usually operational |
| Unmatched group just below a stop | Boards not pushed fully against it or bounced back, cut short | Operational; the band is ±0.6 by default |
| One label stops exactly when another starts, same measured position | The line was relabelled, not moved; both are one physical stop | Merge them in the report; add a separate line if both sizes really run |
| Every stop's measured value steps or drifts at the same time | The camera moved, was rotated or re-zoomed, or its analysis rotation changed | Compare its recordings ([camera view](#camera-view-over-time)); keep the camera setup fixed during production |
| Uncut boards at two or more stops all measure the same percentage short or long | The camera's scale is off by that ratio; every pre-cut length is off by it too | Rescale pre-cut in the report; fix the calibration on the camera |
| Pre-cut peaks at sizes that match no stop and no stock | Pre-cut scale or a stop label is wrong | Confirm with a tape-measured board |
| A cut board shorter than its stop | Impossible physically; pre-cut or a label is off | Above about 1% of cut boards, investigate |
| Many long trims (6 or more units) to one stop | Longer stock being cut down, such as 40-unit boards to 30.5 | Ask whether that is intended; spread over the window means routine, one block means a batch |

## The scale check

Trimsaws routinely pass boards that are already at the stop's length without cutting them. Their
measured length should therefore be about the stop's size. The check takes the uncut boards near
each stop, finds their most common measured length and divides the stop's size by it. When two or
more stops agree within 1%, the ratio is a scale error that applies to every length, especially
pre-cut, which spans the whole board. It is an estimate: a stop that physically sits slightly off
its nominal size shifts it by a few tenths of a percent, so an exact factor from the camera's
calibration is better when known.

**Not on a blade-line camera.** From Vision-App `3df52081` a camera whose stops carry a blade line
(the default) measures pre-cut from where at-size boards end, so uncut boards near a stop measure its
size by construction and this check always agrees. There, judge scale from pre-cut peaks of stock and
tape-measured boards instead.

Matched postcut is reported as the stop's nominal size, so a scale error mostly shows up in the raw
averages, the uncut lengths, unmatched boards and pre-cut. It also moves the derived saw line,
which changes which boards count as cut.

## The size-fit score

One repeatable answer to "how tightly do the cut boards sit on their sizes", so every calibration
change can be measured against the window before it. `check` returns it as `fit`, `report` as
`numbers.fit` (with KPIs, a chart and a per-stop table), and `compare` gives two windows side by
side. calibrate-trimsaw-from-video's `replay-stats` scores video replays with the same definition
(`scripts/size-fit.mjs`).

| Number | Meaning |
| --- | --- |
| `vsSize.within["0.25"]`, `["0.5"]` | Share of cut boards at a stop whose raw Average Postcut is within ±0.25 or ±0.5 of the stop's size (inclusive) |
| `vsCalibration` | The same against each stop's calibration value where one is given with `--calibration 42=41.7`, the size elsewhere; absent without calibration values |
| `medianOffset`, `p10`, `p90`, `width` | Measured postcut minus the size: median, 10th and 90th percentiles, and p90 minus p10 |
| `stops[]` | The same for each stop (relabels merged), busiest first; `cutBoards` says how much it rests on |
| `unmatched.pct` | Target 0 boards as a share of all boards, split into `under1`, `from1to2` and `over2` by distance to the nearest stop (its calibration value when given) |
| `noCut.pct` | No Cut boards as a share of all boards |

Every share and percentile is weighted by boards. A production reading row averages the boards it
holds, which narrows the spread a little compared with a video replay, where each board counts once.

How to read it:

- **Median offset and width together.** A narrow width with a median away from 0 is a steady
  offset of about that size: the camera measures that stop long or short, or the stop physically
  cuts there. A tape-measured board tells which. A wide spread is boards not seated against the
  stop or a camera that cannot see the ends cleanly. The share within ±0.25 falls with either, so
  quote the median and width with it.
- **A calibration value that fits.** For a stop that physically cuts off its nominal size (a 42
  stop cutting 41.7), the boards should centre on the calibration value; `vsCalibration` shows it.
- **Unmatched under 1** are boards just outside the camera's ±0.6 match band, often pushed out on one
  side by an offset. **1 to 2 or over 2** is a size with no stop line, or boards not against a stop.
- **What it cannot show.** The score is in the camera's own scale: a line labelled with the wrong
  size (42.3 for what is really the 40 stop) can score as well as a correct one. The scale check,
  pre-cut peaks and tape-measured boards establish the true sizes.

`compare` takes the first window with `--from`/`--to` and the second with `--vs-from`/`--vs-to`
(`--vs-dataset` for another source or fetch), each with its own `--calibration`/`--vs-calibration`.
Stops pair by equal labels; `--pair 42.3=40` pairs a renamed line with its new label. `change` is
the second window minus the first, and `--format text` prints the table. Keep each window inside one
calibration; a stop with a handful of cut boards is too few to judge.

## Camera view over time

A trimsaw camera measures board ends in a 320 px analysis frame, so its readings are only as steady
as the camera. A camera that turns by a tenth of a degree moves every board end about a pixel,
which at a typical 0.37 in. per pixel is about 0.4 in. on every reading. The `scene` command and the
report's **Camera view over time** section show whether that happened between recordings.

How it works: each raw recording becomes one picture, the median of about 300 frames spread over
the clip, so boards passing through drop out and the floor, machine and stops stay. Every picture
is matched to the reference recording (normally the first after the last calibration) on steady
details only: small patches compared by phase correlation, then one fit of shift, rotation and scale
for the whole view. The shift is then measured along the stop axis of the analysis frame, at each
stop line when the stops are given, and converted to inches with the camera's scale.

| Verdict | Meaning | What to suggest |
| --- | --- | --- |
| Steady | The view moved under 0.5 px along the stop axis | Nothing; drift in the readings has another cause |
| View moved | The whole recorded view moved together by 0.5 px or more | Compare each stop's readings at the same times. Every stop shifting by about the predicted amount in the same direction supports a camera move: check the mount, then recollect. Readings that did not move, or moved in opposite directions, point elsewhere: ask which sizes the site ran that day |
| Part of the view moved | One third of the picture moved unlike the rest | Something in view moved (a guard, a machine part); check what changed there |
| Uncertain | Too few steady details matched, they disagreed, or the picture size changed | Compare another recording from that day |

The section shows the pictures with their shift, an edge overlay of the largest shift (reference
edges red, that recording's cyan, white where they line up) with an enlarged patch, and a table of
every recording. When the view moved, every edge in the overlay shows the same red/cyan fringe in
the same direction. The shift's sign follows the frame's stop axis; the reading change says what it
does to lengths (negative reads shorter).

**A view move is a reason to check the readings, not proof.** The snapshots come from the raw recording. At Kamps Mulberry on 2026-10-22 the recorded view moved 2.1 px between 07:00 and 10:00 while every stop read the same at both times, and the readings swung within half an hour in opposite directions (one stop long while another read short), which no shift, turn or zoom of the camera can do. Recordings minutes apart matched within 0.05 px, so the snapshot measurement itself was sound.

**The camera's own "camera moved" status is not this check.** It comes from the phone's tilt
sensors: pitch or roll more than 2 degrees away from a stored reference, held for 5 minutes. Its
reference is set by the legacy Calibration screen (or the first reading), not by applying, editing
or pushing stops, and it misses the sub-degree turns that matter here. A quiet status does not
mean the view stayed put.

Limits:

- It compares views, not lengths. Confirm the effect on readings with the size fit before and
  after a move (`compare`) or with tape-measured boards.
- Only recordings uploaded to Zira can be compared; the device keeps others until a sync. Choose a
  reference recorded after the last calibration, or the shifts describe the calibration change too.
- A turn of the camera and a slide of the whole saw look the same; both show as the whole view
  moving. Strong lighting changes or a picture full of moving boards can leave a recording uncertain.
- Without stop positions and the scale, shifts are given in analysis px at the frame's centre
  line. The camera's small analysis deskew is ignored.

## What the report cannot tell

- Readings do not include the stop lines' pixel positions or the camera's settings; a relabel is
  inferred from timing and identical measured positions.
- Half-unit neighbours (30 and 30.5) are only a pixel or two apart on a typical camera; expect
  some boards to land on the neighbouring line when both are configured.
- Tape-measured boards remain the ground truth for both stop sizes and pre-cut.

## Neighboring stop buckets

For original labels 0.5 or 1 length unit apart, the report shows two bars per five-minute bucket,
one for each stop, split into recorded cut and uncut boards. The accompanying table includes each
stop's share of this pair's boards (not all production). Empty intervals are gaps in this pair's
readings, not proof that the plant was idle. Counts are weighted by Units, not reading rows.

The paired histogram uses raw Average Postcut on recorded cut boards, never nominal posted Postcut
or corrected pre-cut. Both views use the report's From/To controls. Inspect a short shared window
when asking whether the two sizes ran at the same time: a full-day overlap may combine separate runs.
A separate sample-count table includes boards with missing raw postcut; those boards do not
contribute to the histogram. A small sample does not establish a production pattern.

Nearly identical measured lengths under two labels, with a few boards assigned to the neighboring
bucket during a dominant run, suggest possible assignment spillover. They do not prove a wrong
assignment, an active physical stop, or customer intent. Two distinct peaks support separate groups
but still need an operator, production log or video to establish what was actually produced.
Sequential label changes can produce similar patterns; these charts retain original labels even
when the rest of the report merges a suspected relabel. No boards are automatically reassigned.

At most eight pairs are displayed, ranked by their combined board counts in the authored window.
The report and CLI disclose omitted pairs. Rebuild for another window to change the selected pairs.
