# How the calibration values are worked out

A bucket-path trimsaw camera measures along a straight line between its stops and its derived saw
line. If its calibration is off, every measured length follows one rule:

```
measured = a × real + b
```

`a` is the scale (1.00 when right) and `b` the offset at the stops.

1. **Scale from the anchor's uncut boards.** Boards already at the anchor stop's size pass through
   uncut. Their most common measured length divided by the anchor's size is `a`. Example: uncut
   boards at the 40 stop measure 37.98, so `a = 37.98 / 40 = 0.95`; lengths read 5% short. With
   too few uncut boards at the anchor, `a` comes from other stops when their uncut boards agree, or
   is left at 1 and only the offset is corrected.
2. **Offset from the anchor's cut boards.** Cut boards at the anchor peak at `measured`, so
   `b = measured − a × anchor`. Example: 39.38 − 0.95 × 40 = 1.4.
3. **Real size of every other stop.** `real = (cut-board peak − b) / a`. Example: the 45 stop's cut
   boards peak at 43.83, so `(43.83 − 1.4) / 0.95 = 44.7`. Its uncut boards give a cross-check:
   `42.40 / 0.95 = 44.66`. When the two disagree by more than 0.4, boards may bounce off that stop or
   its line may sit away from where boards stop.

The calibration value to enter on each line is its real size. The size label (the nominal jig size
used for reporting) stays as it is, so a stop that physically cuts 44.7 can still report 45. After
the values are entered the camera refits its scale and saw line from them; lines without enough
boards use the camera's own "Use calibration suggestion", which fits them to the other lines.

## When the values do not apply

- The window mixes calibrations (the plan warns when it finds change points inside it).
- A stop line was moved after the window, or the camera was moved, rotated or re-zoomed.
- The anchor's uncut boards are not at its size (for example short pieces passed on purpose).
- Too few boards: the cut peak needs about 30 boards per stop; 100 or more gives high confidence.

Tape-measured boards remain the ground truth for the anchor and any doubtful stop.
