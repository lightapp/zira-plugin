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
| Uncut boards well short of their stop | Short pieces pushed to a stop, or boards not against any stop | Usually operational |
| Unmatched group just below a stop | Boards not pushed fully against it or bounced back, cut short | Operational; the band is ±0.6 by default |
| One label stops exactly when another starts, same measured position | The line was relabelled, not moved; both are one physical stop | Merge them in the report; add a separate line if both sizes really run |
| Every stop's measured value steps at the same time | The camera moved, was rotated or re-zoomed, or its analysis rotation changed | Keep the camera setup fixed during production |
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

Matched postcut is reported as the stop's nominal size, so a scale error mostly shows up in the raw
averages, the uncut lengths, unmatched boards and pre-cut. It also moves the derived saw line,
which changes which boards count as cut.

## What the report cannot tell

- Readings do not include the stop lines' pixel positions or the camera's settings; a relabel is
  inferred from timing and identical measured positions.
- Half-unit neighbours (30 and 30.5) are only a pixel or two apart on a typical camera; expect
  some boards to land on the neighbouring line when both are configured.
- Tape-measured boards remain the ground truth for both stop sizes and pre-cut.
