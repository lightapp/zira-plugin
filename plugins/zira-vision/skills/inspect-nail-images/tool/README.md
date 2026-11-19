# OpenCV ring inspector

Exploratory, deterministic OpenCV analysis of the visible wood around supplied
nail/fastener boxes. Produces a local comparison page with original crops, fitted
head boundaries, exclusion masks, radial brightness profiles, and uncertainty
reasons. Unlike the image-review-ranker, this tool fits **no classifier** and never
uses labels to choose measurements, weights, or thresholds.

## Guided plugin action and audience

Use Inspect Nail Images in a local Codex or Claude Code session for guided inputs,
setup, analysis and report preview. Packaged Zira builds include this tool; no
private checkout or Zira login is needed. The Python CLI also works independently.
Keep dependencies in a dedicated environment outside the replaceable installation.
No customer dataset is bundled; generated reports contain the supplied images.

## Requirements and setup

Python 3.10+; pinned NumPy and OpenCV dependencies. Node.js is required only for
the offline report-script syntax test:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Installing dependencies requires package access. Running needs no credentials or
network access. Image paths may be absolute or relative to the manifest.

## Usage

```sh
.venv/bin/python inspect_rings.py --input /path/to/manifest.json --output /path/to/new-report
```

Example input (synthetic; ROI coordinates must fit the actual source image):

```json
{
  "title":"Fastener ring comparison",
  "description":"Reference examples for appearance analysis",
  "labelPolicy":"Labels describe appearance, not measured height.",
  "items":[{
    "id":"sample-1",
    "group":"physical-object-1",
    "cohort":"Reviewed indentation",
    "reviewCategory":"indentation",
    "views":[{"path":"patch.png","roi":[48,48,72,72]}]
  }]
}
```

Requires 1–2000 unique IDs, a nonempty physical-source `group`, exactly one view
per item, and a finite `[left, top, right, bottom]` ROI at least 3 pixels across.
The box comes from the caller (manual annotation or an existing detector); this
tool does not locate nails across an entire pallet. Retain surrounding wood.

## Method

1. Operate at native resolution, cropping only a bounded context window. No
   super-resolution, CLAHE, sharpening, or interpolation supplies evidence.
2. Mask blue-dominant pixels using HSV and BGR checks, dilated by one pixel.
   This is an exclusion mask, not a reliable pen detector. Blue reflections can
   also be masked; overlap with the head produces uncertainty.
3. Find Canny contours and fit an ellipse near the supplied box. Candidate gates
   check area, center displacement, fit residual, circularity and angular support.
   When a closed contour fails, fit sparse edges within 0.75–1.25 supplied-box
   radii with gradient/ellipse-normal alignment ≥0.8, one point per angular bin,
   requiring at least 16 of 24 bins and bounded
   residuals. Fall back
   to the supplied box ellipse for diagnostic measurements when no contour fits;
   such results remain uncertain. Even an accepted ellipse needs visual review.
4. Measure 12 angular sectors in four elliptical annuli, 1.12–1.4, 1.4–1.75,
   1.75–2.1, and 2.1–2.6 times the head radius. A sector has ring-like contrast
   when an interior median-brightness trough recovers on both sides, or a dark
   near-head lip recovers in both outer bands, by at least max(5 grayscale
   levels, 0.7 × outer-sector robust variation). The trough and dark-halo fractions
   are retained separately: raised-head shadows can produce the latter.
5. Report near/far Sobel gradient strength, structure-tensor coherence and grain
   orientation agreement. These are descriptive; no rule converts them to height.
6. Recompute after ±1 pixel center or radius perturbations. Appearance bucket
   changes make the result uncertain. Other gates include tiny heads, clipped
   context, too few usable sectors, dark wood, weak texture and unreliable fit.

Fixed exploratory buckets: `ring_like_contrast` (≥40% sectors), `no_clear_ring`
(≤15%), otherwise `uncertain`. Quality gates override either appearance bucket.
`rawAppearance` preserves the ungated bucket for analysis. Every item explicitly
records `physicalHeight: not_measured` and `pnDecision: not_made`.

The fixed configuration is in `CONFIG` and is copied into every report. No
parameter search or training happens. If you revise rules after inspecting data,
evaluate on independent physical objects before claiming generalization.

### Separate troughs from adjoining halos

To diagnose whether a ring rule is conflating interior troughs with near-head
shadows, replay an existing baseline with its exact original manifest:

```sh
.venv/bin/python compare_ring_rules.py \
  --input /path/to/manifest.json \
  --baseline /path/to/ring-report/results.json \
  --output /path/to/new-ring-comparison
```

This ablation compares the original trough-OR-halo score, trough alone, and halo
alone. It freezes the native crops, fitted head ellipses, radial bands, contrast
thresholds and quality gates. Each score gets its own seven-variant ±1-pixel
stability check. It does not fit thresholds or use labels as measurement inputs.
“No clear trough” is an appearance measurement, not proof that an indentation is
absent; a trough also does not establish physical depth or a safe nail height.

Before output, the command verifies manifest/algorithm/source hashes, config,
item sets, ROI/context, review metadata and a complete replay of baseline analyses.
Numeric replay drift is limited to 0.00001; structure and decisions must match.
Report all cohorts and failures: a higher raw no-trough count in raised examples
is not an improvement if indentation controls also gain that appearance.

Outputs are `results.json`, `review.html`, native crops and separate sector
overlays, with all twelve radial profiles and raw/qualified cohort counts.
The HTML can filter cohorts and raw no-trough cases. Stdout contains a JSON summary;
errors go to stderr with exit code 1, success returns 0. Existing outputs are
refused; a write failure can leave partial output. Sources remain unchanged.
No new dependencies, network calls, uploads, training or production changes.
Tests cover halo/trough separation, failed quality gates, replay provenance,
native pixels, escaping, cohort denominators and refusal to overwrite.

### Sector grain comparison and evidence marks

```sh
.venv/bin/python inspect_grain.py \
  --input /path/to/manifest.json --baseline /path/to/ring-report/results.json \
  --reference-cohort 'Reviewed indentation' --comparison-cohort 'Confirmed raised' \
  --review-id sample-1 --review-id sample-2 --output /path/to/new-grain-report
```

The comparison cohort arguments are optional but must be supplied together.
Repeated review IDs set the first annotation batch; all cases remain accessible.
Inputs undergo the same complete frozen-baseline verification as ring ablation.
Eight elliptical angular sections compare near wood at 1.12–1.75 head radii with
reference wood at 2.1–2.6 radii. Sobel footprints touching the metal core, blue
mask or image border are excluded. Each section needs twelve pixels per band,
reference gradient RMS ≥3 and reference coherence ≥0.25. These exploratory
support gates are fixed, not fitted to labels.

The primary measurement averages the two largest increases in gradient energy
perpendicular to the reference gradient direction, requiring at least six valid
sections. Secondary measurements are coherence loss, direction change and relative
edge density. These quantify image gradients, **not identified crushed fibres,
cracks, indentation depth or physical protrusion**. Radial shading can increase
the score even over unchanged grain. Constructed controls explicitly retain that
failure alongside unchanged texture, brightness, illumination ramp and rotated
near-head texture. They do not simulate a physical raised nail.

Seven one-pixel boundary variants retain all values, source quality gates,
support failures and context clipping. Cohort counts include excluded examples.
Pair-ordering summaries use a fixed subset usable under every perturbation and
report overlapping score ranges; they are not independent accuracy or a fitted
threshold. Reused images and differing physical-source groups, capture conditions
and head sizes can confound ordering. No score is converted to a PN decision.

The report includes an original-pixel annotation canvas and a measurement overlay.
Draw indentation/rim, crushed fibre, intact grain, head-boundary or unclear strokes;
record review status and notes. Undo removes the last stroke. Marks autosave to
browser local storage when available; export `wood-grain-marks.json` as a portable
backup. The visible JSON field provides a copy fallback. Stored records carry
manifest/image hashes, crop geometry and continuous coordinates measured from
native crop pixel edges; add the crop left/top to recover source coordinates.
Reload validation rejects mismatched provenance, coordinates or stroke types.
Marks are evidence annotations, not relabeling, training inputs or production data.

Output is a new local directory with HTML, JavaScript, JSON and native PNGs.
The page makes no network requests. Browser storage and downloaded JSON are the
only additional writes. Source files stay unchanged. Stdout is a JSON summary,
stderr contains errors, and exit codes are 0/1; write failures may leave partial
output. Dependencies are unchanged. Checks include synthetic feature response,
shading confounds, core exclusion, boundary clipping, fixed comparison subsets,
native sources, and annotation coordinate/save/undo/reload behavior with a DOM fixture.

## Inputs and outputs

Writes `review.html`, `results.json`, native-pixel raw/overlay/mask PNGs and contact
sheets (display enlargement only, preserving aspect ratio) in a
**new** directory. No existing report is overwritten. Invalid manifests are
rejected before directory creation; execution failures can leave partial output.
The page supports cohort/result/ID filters, zoom, and hiding reference labels.
Enlargement uses nearest-neighbor display; numeric measurements use originals.

JSON contains source/manifest SHA-256 values, configuration, runtime versions,
box/ellipse coordinates, per-sector values, uncertainty gates, timings and cohort
counts with independent-source counts. Timing is desktop analysis time, not an
Android latency estimate. Cohort counts are descriptive, not PN accuracy metrics.
Stdout prints a compact summary. Errors go to stderr; exit 0 means success and
exit 2 means invalid input or analysis/write failure.

## Side effects

Reads local input files and writes the new report directory only. No cloud/device
access, trained model, source image changes, automatic annotation or production
PN decision. Reports embed reference labels and customer imagery; store them
outside this repository and follow the original data's access requirements.

## Checks

```sh
.venv/bin/python -m unittest discover -s tests -v
```

Synthetic fixtures cover annular trough measurements, pen-colored overlap,
small/clipped regions, unchanged sources, label independence, manifest validation,
overwrite refusal and HTML escaping. These verify implementation, not real-world
height detection. Catalog checks need this environment's Python on `PATH`.

## Limitations

A dark ring may be a head shadow, indentation, dirt, rust or a segmentation error.
Its absence does not establish protrusion; wood grain continuity cannot reliably
measure 1 mm from one image. Subtle crushed fibers need human review. Head sizes,
lighting, camera, pallet age and cohort selection can confound comparisons. An
ellipse constrained by the supplied box can fit an inner head or an outer rim;
inspect overlays. One-pixel sensitivity is only a local robustness check, not a
confidence interval. The ring entry point is a single-view baseline. Unverified
examples must remain unverified. The motion replay below does not measure depth.

## A/center/B motion replay

`inspect_motion.py` measures motion relative to the wood without a classifier.
It accepts native context crops up to 512 pixels per dimension. Reference labels
are displayed but never used for registration or gates.

```sh
.venv/bin/python inspect_motion.py --input /path/to/triplets.json --output /path/to/new-report
```

Synthetic input (matrices map **A crop pixels to alternate crop pixels**):

```json
{"items":[{
  "id":"head-1", "group":"object-1", "reviewCategory":"unreviewed",
  "roi":[180,180,204,204],
  "boardPolygon":[[0,0],[383,0],[383,383],[0,383]],
  "excludedBoxes":[[180,180,204,204]],
  "baselines":{"center":[0,200],"B":[0,600]},
  "views":{
    "A":{"path":"a.png"},
    "center":{"path":"center.png","referenceToView":[[1,0,0],[0,1,0],[0,0,1]]},
    "B":{"path":"b.png","referenceToView":[[1,0,0],[0,1,0],[0,0,1]]}
  }
}]}
```

`baselines` are **uncropped frame-space displacement vectors** from A to center/B,
in the same image axes. Do not use translation components from independently
centered crop mappings. Missing baselines prevent a repeatable-motion result.
Exclude every nearby nail, including heads outside the review subset. Missing
board geometry is rejected; incorrect board geometry can invalidate the analysis.

The algorithm fixes 24-pixel wood templates on a 48-pixel grid from A alone. Entire
8-pixel search footprints stay inside the supplied board (8-pixel inset) and outside
expanded nail boxes (12 pixels) and blue-pixel exclusions. A deterministic third
of cells is held out from fitting. Fit and validation search footprints are disjoint;
the gap also covers the one-pixel bilinear interpolation support.

Normalized grayscale template matching provides wood correspondences. Local affine
RANSAC needs six inliers surrounding the head, 65% consensus, ≤0.75-pixel fit error
and plausible scale/shift. Three separately matched held-out templates must also
surround the head and each validate within 0.75 pixels. Matching requires ≥0.80
correlation, ≥0.04 peak margin and an interior search peak. All parameters are saved.

Only after wood validation does it match the head in grayscale and gradient
magnitude, requiring agreement and a reverse match within 0.75 pixels. Motion over
1.5 pixels requires center trajectory agreement and alignment with conveyor motion.
Results are `repeatable_relative_motion`, `below_pixel_threshold`, or `uncertain`.
**None is a PN classification. Small motion does not exclude a raised nail.**
Specular highlights, shadows, flexible wood, lens distortion, unknown nails and
bad boxes remain confounders. Conservative gates can reject an entire real batch;
synthetic tests do not establish real nail-detection accuracy. Do not lower gates
solely to obtain positives. This is an offline alternative experiment, not a
bit-identical replay of an application's native alignment implementation.

Reports contain raw crops, interpolated alignment previews (which may still be
rejected), enlarged head details, fit/validation overlays, hashes and all rejection
reasons. ID/status filters and zoom help inspection. Desktop timings are not phone
latency. `physicalHeight` is always `not_measured`; `pnDecision` is `not_made`.

### Preparing native crops from full snapshots

```sh
.venv/bin/python prepare_motion.py --input /path/to/scenes.json --output /path/to/new-crops
.venv/bin/python inspect_motion.py --input /path/to/new-crops/manifest.json --output /path/to/new-report
```

The preparer accepts `{"scenes":[...]}`. Each scene contains `group`,
`views:{"A":"a.jpg","center":"center.jpg","B":"b.jpg"}`, `boardPolygons`,
`excludedBoxes`, and `heads:[{"id":"head-1","roi":[left,top,right,bottom]}]`.
Scene boxes and polygons use **center-image native pixel coordinates**. Optional
head `reviewCategory` and `reviewNote` are metadata. Include all known nails in
exclusions, even when reviewing a subset.

SIFT runs at up to 1536 pixels with board masks and expanded nail exclusions in the
center image. Coarse homography gates require 40 inliers, 40% consensus and 35%
span in both reference-image axes. Independent local checks remain mandatory.
The source A crop is 384 pixels; other crops use mapped bounds plus a 16-pixel
border. There is no resizing. Clipped/oversized crops are recorded as rejected,
never silently padded. The smallest supplied board containing the nail is chosen.

Outputs: PNG crops, `manifest.json`, and `preparation.json` with source hashes,
coarse transforms, quality metrics and skipped heads. Both commands use the same
dependencies and tests as the ring inspector. They require no credentials/network,
write to a **new** local directory only, preserve source images, print a JSON
summary, and exit 2 on input/processing errors. Failures may leave partial output.
Neither command changes remote labels, device settings or inspection decisions.

## Adaptive selection and masked ECC comparison

```sh
.venv/bin/python compare_alignment.py --input /path/to/triplets.json \
  --input /path/to/another-manifest.json --output /path/to/new-comparison \
  --control-groups 4
```

This uses the same crop manifests and compares `fixed`, `adaptive`, `ecc` and
`translation_first`, `similarity` and `direct_affine` on
identical pixels. IDs must be unique across inputs. Outputs are a local HTML
comparison, PNG previews and `results.json`, with method configuration, source
hashes, layout eligibility, every failed check and all controlled cases. Existing
output directories are refused. Progress goes to stderr and the summary to stdout;
exit codes are 0/2. Runtime, dependencies and local-only side effects are unchanged.

Adaptive selection scans 24-pixel candidates every 8 pixels in A, checking the full
search footprint against board/nail/ink exclusions. Self-matching tests reference
texture distinctness. Eight deterministic greedy packings are considered; three
validation patches must surround the head, with fitting support reserved separately.
Selection never sees another view or a review label. Reference eligibility includes
spatial coverage as well as template counts; distinguish it from a counts-only audit.

The ECC variant fits an affine transform from dense remaining wood. Validation
search footprints plus 10-pixel borders are removed, then a further 13-pixel guard
is eroded from the fit mask. At least 1000 fitting pixels must surround the head.
OpenCV 4.12 exposes an input-image mask, so ECC runs one iteration per call: every
returned transform is checked before another iteration can sample with it. Corner
displacement must stay within 8 pixels and singular values within 0.95–1.05.
The guards cover allowed motion, validation search and interpolation/filter support.
Tests verify that changes confined to withheld patches or heads do not affect the
fitted transform. Solver errors, low fit correlation and out-of-guard steps reject.
Reaching the iteration budget without step tolerance is recorded separately;
independent validation still determines whether the resulting alignment is usable.

Three held-out patches are validated in the wood-aligned image, so rotation and
scale are applied before checking their residual translation. The correlation,
peak-margin and residual limits remain 0.80, 0.04 and 0.75 pixels. The head gates
are shared with `inspect_motion.py`. A high ECC fitting score alone never accepts
wood alignment or a protruding nail. All methods remain experimental and can reject
every real pair; more eligible layouts do not establish better defect detection.

Controls select the first item from the first N distinct physical groups per input,
without filtering by label or successful layout (`0` disables them). Each source
gets a known 2/−1-pixel whole-image translation and 0/1/2-pixel head-region shifts,
with clean, brightness, blur and combined appearances. Nonzero head regions are
copied to a shifted position after inpainting the old location. These are tests of
image-space measurement, **not physical protrusion or realistic reflectance**.
The same source is reused across conditions; cases are not independent specimens.
Reports include rejections in denominators and show false movement only among
accepted zero-shift controls. Never interpret rejected controls as correct negatives
or conditional error statistics as production accuracy. Controls and real-pair
results remain separate. No labels are changed and no images are uploaded.

## Held-out wood null test

```sh
.venv/bin/python wood_null_test.py --input /path/to/triplets.json \
  --input /path/to/another-manifest.json --output /path/to/new-wood-report
```

This diagnostic asks whether wood excluded from registration stays still after
alignment. It compares nested 24, 48 and 64-pixel patches at the **same location**
using one transform. It uses the same manifests, dependencies and local-only
permissions as the motion replay. No nail classification or height is produced.

Selection uses A alone: scan every 8 pixels for a distinctive 64-pixel footprint
inside board/nail/blue-pixel exclusions, with a 10-pixel margin. Select at most two
locations per item, separated by 96 pixels. Each gets an independent fit excluding
its largest probe and the existing ECC guards. At least 1000 fitting pixels must
surround the probe. All sizes use that same fit, even if smaller patches would
allow more fitting support. This tests common 64-pixel-eligible locations; it does
not compare every location available to each patch size. Incorrect board geometry,
undetected nails and wood outside a common plane can still invalidate a real probe.

Matching gates stay at correlation 0.80, peak margin 0.04 and an interior peak.
Matched residuals above 0.75 pixels are retained as null-test failures. The report
also counts residuals at least 1.5 pixels, **not PN detections**. Ambiguous matches
and rejected fits remain in denominators; small residuals validate only that probe,
not a nail or the three-surrounding-validator gate used by the motion replay.

Controls use the first eligible probe from up to four distinct physical groups
per input, without selecting on target-image results. Each A crop receives known
integer (2/−1) and subpixel (2.35/−1.65) translations with clean, brightness, blur
and combined appearances. All have zero relative motion. The same patch matcher
also runs with the exact generated transform, bypassing ECC. This distinguishes
fitting errors from interpolation/matching errors. Reused source crops and two
views of the same item are not independent specimens. These image manipulations
do not reproduce physical protrusion, reflections or all camera processing.

Brightness, contrast and contrast-normalized Laplacian energy are recorded for
aligned patches and approximate native target bounding boxes. The latter avoid
resampling but do not have precisely identical footprints. These are diagnostic
proxies, not focus/shutter measurements. Normalized correlation already compensates
for uniform gain and offset; brightness differences alone do not prove causation.

Outputs are `review.html`, `results.json` and PNG context, fit-mask, native and
aligned previews. Source and algorithm hashes, all failures and every control are
included. Progress goes to stderr, a JSON summary to stdout, exit codes are 0/2.
The output directory must not exist; an error may leave partial output. Inputs are
never modified and the command performs no network or device operations. Generated
reports contain customer imagery and must remain outside the shared tool repository.

## Translation-first registration

The existing ECC baseline is preserved. Select the new experimental path for the
same held-out wood test with:

```sh
.venv/bin/python wood_null_test.py --input /path/to/triplets.json \
  --registration translation_first --output /path/to/new-translation-report
```

`compare_alignment.py` also includes `translation_first` alongside its previous
methods, using exactly the same reference-selected three wood validators and head
gates. This checks whether an improvement in a single wood probe actually survives
the full nail-motion pipeline. Defaults for the wood null test remain `ecc`.

Translation-first fits grain detail using Gaussian-5 minus Gaussian-9 filtering
on both images. This removes broad illumination ramps from the fitting objective;
**held-out wood and head matching still use the original pixels and unchanged
0.80 correlation / 0.04 peak-margin / 0.75-pixel validation limits**. The fitting
filter, search, interpolation and derivative support remain within the reserved
mask guards. No reviewed label or withheld score selects the transform.

The fitting steps are:

1. Require at least 1000 fitting pixels, raw texture standard deviation of 5,
   and a reference gradient eigenvalue ratio of at least 0.01. Flat texture and
   the aperture ambiguity of parallel grain are rejected.
2. Search integer translations inside an 8-pixel circle with zero-mean correlation
   over only fitting pixels. Require peak separation of 0.04 and a peak more than
   one pixel inside the circular search boundary. Refine the peak with a bounded subpixel
   quadratic estimate. Unlike iterative affine fitting, this has no convergence
   budget that can silently expire.
3. Attempt seeded, bounded affine ECC only when the normalized six-parameter
   reference Jacobian has eigenvalue ratio at least 0.001. Every returned step
   remains subject to the existing 8-pixel / 0.95–1.05 scale guards. Require three
   consecutive iterations with maximum corner movement no greater than 0.05 px;
   exhausting the 40-iteration budget rejects that affine candidate.
4. Choose the affine candidate only if it improves the grain-detail fitting score
   by at least 0.002. Otherwise retain translation. The selected transform must
   score at least 0.80 on fitting wood; a low translation seed can only survive
   through a valid affine refinement. Failure reasons and selected models are
   recorded. Independent wood validation is mandatory after either choice.

These fitting parameters are fixed in `TRANSLATION_CONFIG` and saved in reports.
They are not calibrated physical-height thresholds. Known-zero controls must be
examined with their unavailable cases, and increased rejection can reduce coverage.
Passing generated controls does not establish accuracy on real nails. Source
hashes and selected probe geometry allow comparisons against older reports.

Additional tests cover integer/subpixel shifts under blur and brightness changes,
spatial illumination ramps, small rotation/scale, repeating and parallel texture,
withheld-pixel independence, affine instability/guard rejection and preservation
of a known independent head shift. This remains an offline experiment: it changes
no application code, phone setting, remote label or production decision.

## Constrained translation, rotation and uniform scale

```sh
.venv/bin/python wood_null_test.py --input /path/to/triplets.json \
  --registration similarity --output /path/to/new-similarity-report
```

The full `compare_alignment.py` replay includes `similarity` alongside all previous
methods. This candidate uses the same translation seed, wood-detail filtering,
reference-selected masks and unchanged original-pixel wood/head validation gates.
It allows only center translation, rotation and uniform scale: no shear or separate
horizontal/vertical scaling. The existing 8-pixel corner-displacement and 0.95–1.05
scale guards constrain every trial before any target pixels are sampled.

`similarity_fit.py` optimizes zero-mean normalized correlation directly on the
reserved fitting pixels. It uses exact bilinear-image derivatives, a normalized
four-parameter Jacobian, damped Gauss–Newton steps, and a backtracking search that
requires a nondecreasing fitting score. Trial steps are capped at one pixel of
corner movement. Ill-conditioned fits, trials entirely outside the bounds, failed
large updates and iteration-budget exhaustion are rejected.

Convergence requires three consecutive proposed and accepted corner steps no
greater than 0.05 pixels. A step made artificially small by a bound does not count
as convergence. The fitted candidate must improve the fitting score by at least
0.002 and meet the 0.80 fitting-correlation gate; otherwise only an independently
eligible translation is retained. The withheld wood never selects the fit and
still must validate afterward. Raw input and original-image validation thresholds
are not altered by the detail filter.

Reports include the new solver configuration/hash, score trajectory, convergence,
conditioning, scale/rotation and rejection reasons. This is both a constrained
transform and a different fitting solver; comparisons against the old affine ECC
path cannot attribute every difference solely to the number of parameters. Small
wood-probe errors or successful synthetic controls do not establish real nail
accuracy or physical height. Report real-data coverage and failed cases alongside
conditional residual statistics, and preserve the baseline when adoption criteria
are not met.

Tests cover small rotation/scale recovery, known-zero motion under blur and a
lighting ramp, exact withheld/head-pixel independence, preserved independent head
motion, analytic interpolation derivatives, pre-sampling bounds and convergence
failure. The implementation adds no dependencies or network/device side effects.

The default controls retain the original translations for a paired comparison.
Also test the new model against known rotation and scale on real source textures:

```sh
.venv/bin/python wood_null_test.py --input /path/to/triplets.json \
  --registration similarity --control-geometry similarity \
  --output /path/to/new-rotation-controls
```

This replaces the two translation-only control transforms with +0.6° / scale 1.006
and −0.6° / scale 0.994 about each crop center, retaining translations of 2/−1 and
2.35/−1.65 pixels respectively. The same source selection and four appearance
conditions apply. Matrices and control geometry are recorded, and each condition
is also measured using its exact generated transform. The real-image portion is
unchanged. Report rotation/scale control results separately from the default
translation controls rather than silently changing their denominator. These are
still image-space controls, not physical protrusion simulations.

## Direct affine solver ablation

`direct_affine` uses the same masked optimizer, translation seed, filtering,
iteration budget, convergence requirement, score-gain rule and independent gates
as `similarity`, but fits six parameters instead of four. The extra parameters
permit shear and different scales on the two axes. This is an affine residual
correction, not a projective homography. It isolates transform flexibility within
the direct solver; it is not equivalent to the older ECC objective or procedure.

```sh
.venv/bin/python wood_null_test.py --input /path/to/triplets.json \
  --registration direct_affine --output /path/to/new-affine-report
.venv/bin/python wood_null_test.py --input /path/to/triplets.json \
  --registration direct_affine --control-geometry affine \
  --output /path/to/new-affine-controls
```

The full alignment comparison includes this method automatically. Both methods
share `similarity_fit.py`; its default four-parameter interface is preserved.
Affine parameters represent center translation and radius-normalized deviations
from the identity 2×2 linear block. Derivatives come from the same bilinear
interpolant. Every proposal is guarded before sampling, with the same 8-pixel
maximum corner displacement, positive determinant and 0.95–1.05 singular-value
bounds. Refinement failures can retain only a translation that independently
passes the fitting-score gate. Reports record selected models, singular values,
determinant, objective history and reasons, including rejected candidates.

The optional affine controls use center-relative linear blocks
`[[1.008, 0.010], [-0.006, 0.993]]` and
`[[0.993, -0.009], [0.007, 1.007]]`, with the same two translations and four
appearance conditions as other controls. They exercise unequal scales and shear;
the source selection and real-image measurements are unchanged. Compare them
against their exact generated transforms and report them separately from the
translation controls. A good fit can still have an ambiguous held-out match under
blur, even with the exact transform. Such cases remain rejected.

Tests cover affine recovery, generated geometry, zero motion under blur and a
lighting ramp, independent head motion through an affine transform, withheld-pixel
independence, pre-sampling guards, convergence limits and translation fallback.
This remains an offline diagnostic: passing more wood probes does not establish
valid nail trajectories or PN detection. No new dependencies or side effects.

## Fixed smoothing with frozen transforms

`compare_smoothing.py` tests matching independently of registration. Supply the
original crop manifests, one or more existing `direct_affine` wood-null reports
(different control geometries) and the full alignment comparison report:

```sh
.venv/bin/python compare_smoothing.py \
  --input /path/to/triplets.json --input /path/to/another-manifest.json \
  --wood-report /path/to/affine-translation-controls/results.json \
  --wood-report /path/to/affine-shear-controls/results.json \
  --head-report /path/to/alignment-comparison/results.json \
  --output /path/to/new-smoothing-report
```

The single predetermined filter is Gaussian 3×3, sigma 0.8. It is applied equally
to the reference and wood-aligned target in grayscale, after alignment. Five head
pipeline variants are reported: raw, wood-only smoothing, head-only smoothing,
both, and raw-first wood fallback with head smoothing. Wood-null probes compare
raw, smoothed and raw-first matching. The head gradient
calculation retains its existing Gaussian/Sobel step after optional smoothing.
The raw path remains the default in existing commands.

Cached fits, rejected fits, source locations and template layouts are frozen.
There is no registration or parameter sweep. The replay verifies source image and
manifest hashes, item sets and current matching/registration gates before running.
Multiple wood reports must contain identical real measurements. Cached affine
transforms must remain within the existing bounds. Every raw wood/head measurement
is reproduced and checked against the baseline, including generated controls.
Decisions and structure must match exactly; numerical values allow at most 0.00001
absolute difference for OpenCV floating-point replay noise. The largest difference
is recorded. This tolerance never changes any acceptance threshold or decision;
incompatible inputs fail rather than silently starting a different comparison.

Correlation, peak margin, texture, residual, reverse matching, channel agreement
and trajectory thresholds remain unchanged. Texture strength is measured on the
matching image; smoothing can therefore make previously acceptable texture too
weak. High correlation does not override an ambiguous peak. The optional path
checks the added filter support: one pixel for wood, three for heads including
the existing gradient footprint. Failed registration cannot be rescued by smoothing.

Controls reuse exactly the baseline sources, transforms, appearance conditions
and independent head shifts. Known-transform wood measurements are also retained.
Report both gains and losses and keep rejected controls in denominators. Zero
false motion among a smaller accepted subset does not imply an overall improvement.
One accepted image pair does not establish a valid trajectory or a PN.

The raw-first path preserves every passing raw wood check. A confident raw match
whose residual exceeds the wood limit is also preserved as a rejection: smoothing
cannot conceal a geometric contradiction. Only `weak_texture` and
`ambiguous_template_match` failures can retry with the same fixed smoothing and
unchanged gates. Clipped support cannot retry. Each retry records the raw attempt,
selected path and final measurement. All three independent validators must still
pass. This is an additional acceptance path, not a replacement default.

`matching_negatives.py` adds deterministic wrong-correspondence controls using the
baseline's preselected source groups. They bypass registration with a known
identity transform to isolate validation and head matching. Cases include a
two-pixel whole-image alignment error on each axis, a two-pixel shift of each
individual validator footprint, another pallet, and another nail head inserted
without resizing while preserving the surrounding wood. Donors come from the
next different group with the same native image shape. Each case is checked clean
and with the existing brightness/blur perturbation; missing donors, clipped
support and sources lacking three validators are reported as skips. These are
wrong image correspondences, not simulations of physical protrusion.

Reports separate false acceptance at the expected wood/head stage from acceptance
of a full pair. Head-control eligibility requires passing wood checks; report this
denominator instead of crediting wood failures as successful head rejection. Full
native previews are saved for any falsely accepted case. Reused source crops and
constructed errors do not provide an independent production false-positive rate.
Keep both successful and rejected controls in the report; do not tune this fixed
comparison against individual failures.

Outputs are `review.html`, `results.json` and enlarged native/aligned/smoothed head
previews. Reports include source/baseline/algorithm hashes, fixed configuration,
each variant's measurements, trajectories, controls and rejection reasons. Progress
goes to stderr, the summary to stdout, and exit codes are 0/2. The output directory
must not exist; an error can leave partial output. Input images and reports are
never modified. No network, device, production or label writes occur. Runtime and
dependencies are unchanged; keep generated customer reports outside this repository.

Tests cover exact raw reproduction without fitting, independent head/wood shifts,
blur and brightness, flat/repetitive texture rejection, added support clipping,
failed/out-of-bounds cached fits, source/gate mismatches, provenance, HTML escaping
and refusal to overwrite a report. Fallback tests verify preservation of raw
passes and geometric vetoes, restricted retries, retained failure evidence,
wrong-alignment and single-validator rejection, native donor pixels, explicit
stage-specific false-acceptance counting and unchanged source arrays.
