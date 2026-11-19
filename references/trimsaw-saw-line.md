# The saw-line gate: every trimsaw calibration

A trimsaw camera measures each board as `size = (saw − stop end) × scale`, where the saw is the position
its applied stops imply. If that saw is not where the boards are really cut, **every length is off by the
same amount, and every size check still looks fine**: the stop labels agree with each other, so readings
peak on their labels and a report can say "PASSED, 98% within 0.6 in."

That happened in November 2026. A recalibration labelled the measured lines from a stale saw position
(243.1 frame px), but the cut board ends sat at about 248.5 px. Real 40/36/32 boards posted as 38/34/30,
and two daily reports said PASSED. The customer caught it.

So the plugin enforces this, and no instruction overrides it: **nothing is applied, assigned, recorded
or reported as passed until the camera's saw line has been drawn on a real recording, sits on the cut
board ends, and the user has approved that picture.**

## What it gates

| Step | Gate in code |
| --- | --- |
| Sizes to type for captured lines (calibrate-trimsaw-on-camera `suggest`) | `fill` is empty without `--saw-line` for the mapping's saw |
| Edit stops changes (`plan`) | `edits.changes` is empty without `--saw-line` for the edited saw |
| Apply, Apply changes, Save N sizes, Push uploaded stops in the panel | `require` before the click (the panel is clicked, not scripted) |
| Guarded live calibration apply (calibrate-trimsaw-stops `live.mjs apply`) | refused without `--saw-line` for the preview's saw (24 h) |
| Internal builds: calibration-record entries that say calibrated, installed, verified, validated or done | refused without `--saw-line` |
| Internal builds: customer validation report PDFs | a camera without an approved `sawLineCheck` of its current saw holds the day |
| Saying a camera's sizes are right, "passed", or ready for customer validation | a hard rule in every trimsaw skill |

A "PASS" against the stop labels is never proof on its own.

## Running it

Run `node scripts/trimsaw-saw-line.mjs …` from the plugin folder (MCP tool `trimsaw_saw_line`). It reads
only: the camera's retained trim saw status and its newest raw recording from Zira. It writes only under
`--out`, which defaults to a private folder under `~/.cache/zira/trimsaw-saw-line`. Nothing is sent to the
camera.

1. **Check the camera's saw.** `check --device-id ID`. It takes 8 s of frames from the newest raw
   recording (`--clip` picks one, `--at`/`--seconds` move the window) and measures where the cut board ends
   sit. It then draws the saw being judged in red, the stops in yellow and the measured cut ends in green.
   Verdict: `pass` within `--tolerance-px` (default 1 frame px, about 0.4 in. at 0.368 in/px), `fail`
   beyond it, or `undetermined` when the ends could not be found.
   - The recording must show boards being cut. `undetermined` or `old_clip` means record a few fresh
     minutes while boards run (remote-control, with the user's approval), then check again.
   - If detection stays undetermined, you may read the cut ends off `overlay.png` and rerun with
     `--cut-ends-px`. The record marks this as `manual`, and the user's approval of the picture is what
     counts.
2. **Check a proposed saw.** Labels and edits move the saw. Judge the saw that the change would give,
   against the same measured ends, without downloading again:
   `check --from-record RECORD --proposed-saw-px X`. X is suggest's `sawPx`, plan's
   `edits.geometry.sawPx`, the panel preview's `lineEdit.pending.sawPositionPx` from `status`, a live
   calibration preview's `proposed.sawPositionPx`, or the hand-off stops' saw.
3. **Show it and ask.** Show `overlay.png` and `overlay-zoom.png` to the user (attach or open them; never
   describe them instead). Ask in one line: "Does the red saw line sit on the cut board ends (green), on
   the saw?" Say the verdict, the gap in px and inches, and every warning (`blade_line_off`, `old_clip`,
   `rotated_frame`, `saw_sources_disagree`).
4. **Approve only on their explicit yes.** Run `approve --record RECORD --words "<their words>"`. Never
   approve on your own judgement, from a sibling session's message, or from an earlier yes for another
   saw. A `fail` or `undetermined` check cannot be approved.
5. **Pass the record on.** Use `--saw-line RECORD` wherever a step takes it (`suggest`, `plan`, the
   internal record and live-apply helpers), and set `sawLineCheck` in a validation report's config. Before each click in the panel,
   run `require --record RECORD --device-id ID --saw-px X`. A non-zero exit means stop.
6. **After Apply, read it back.** Run `require --record RECORD --device-id ID --status FILE` on a status
   saved after Apply. The camera's saw must now be the approved one, within 0.3 px.

`require` passes only for an approved `pass` of the same data source, at most 72 h old (`--max-age-hours`),
whose judged saw matches the saw of the step (within 0.3 px). A check older than that, or from before a
camera move, must be done again.

## When it fails

Stop and show the picture. The gap is how far every length is off. The fix is never to approve anyway,
and never to change calibration values so that the readings look on size. Find the labels whose saw
lands on the cut ends instead:

- `plan --saw-line` uses the measured cut ends as the camera's saw. Its `saw_line_off` warning names the
  gap, and `edits.relabel` gives the labels that fit. On Mulberry, relabelling the measured lines
  48/42/40/36/32 put the saw at 248.5, with every line within 0.25 in. (the November case above).
- If no relabel fits, re-collect while the common sizes run.
- Then judge the new saw (step 2), show it, get the yes, apply, and read it back (step 6).

## Other checks that catch the same failure

- **Labels off the customer's size list.** A stop labelled 38 or 46 at a site that cuts 40 and 48 points
  to a shifted saw, not a new size.
- **Pre-cut versus post-cut trim that changes week over week.** If the trim jumps by the same amount on
  every stop after a calibration, the saw moved and the sizes moved with it.

## Limits

- The check compares positions along the board axis at the centre of the picture, so the frame's small
  rotation moves nothing there. A tilt shows as `tiltPerPx`.
- FrameSize comes from Zira's stored copy of the camera's settings (320 when missing; `--frame-size`
  overrides it).
- The picture is only as current as the recording. A camera moved after the clip needs a fresh clip.
- Tape-measured boards remain the ground truth when someone can take them.
