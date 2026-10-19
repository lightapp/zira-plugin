---
name: inspect-nail-images
description: Inspect local nail or fastener images for nail-head appearance, surrounding wood texture and movement across aligned views, using OpenCV measurements and visual reports. Use supplied images and nail regions; not general image review, whole-pallet defect detection, live device health or production pass/fail decisions.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Turn local inspection images into a reviewable report inside the conversation. The Zira package includes the OpenCV tool and its assets. It needs local filesystem access and the Zira MCP server and a separate Python environment; ordinary chat can discuss the review but cannot run it. Offline analysis needs no Zira login or private GitHub access. See [requirements and build identity](../../references/distribution.md).

## Guide the review

Reuse supplied details. Ask only for missing intent, local image/manifest paths and a new output folder. For an unspecified request, offer nail appearance, surrounding wood detail, or movement/alignment across a sequence. Explain the result in operator terms: which examples need a closer look and why. Do not run every experimental comparison by default.

Run `node scripts/runtime.mjs status` from this skill's directory. It reports the package-local tool, README, dedicated Python environment and missing requirements. Read the returned README for manifests, commands, gates and outputs. Record `node ../../scripts/build-info.mjs` for the loaded version and source revision. Never discover an unrelated checkout automatically in an installed package. An internal developer may explicitly select `--tool-root PATH`; source checkouts use the canonical repository tool when no bundled copy exists.

If dependencies are missing, explain the required Python and pinned OpenCV/NumPy packages before setup. With the user's consent, call `nail_images` with `command: "setup"` (Python 3.12 must be installed); optionally pass a new `--runtime DIRECTORY` outside the plugin. The helper refuses to modify an existing incompatible environment. Use `nail_images` with `command: "run"`, `--script` set to the selected name without `.py`, and `--args` containing a JSON array of that script's arguments.

## Select inputs and method

Read only the relevant README section before choosing a command:

| Question | Starting point |
| --- | --- |
| What does the area around these nails look like? | `inspect_rings.py`: Usage and Method |
| Is surrounding wood texture disrupted? | `inspect_grain.py`: Sector grain comparison and evidence marks |
| How does a nail move relative to wood across three views? | `inspect_motion.py`: A/center/B motion replay |
| Prepare native crops from full snapshots | `prepare_motion.py`: Preparing native crops from full snapshots |
| Compare registration, smoothing or ring rules | Matching advanced section; preserve required baseline/provenance |

The tool needs caller-supplied nail regions; it does not find every nail in a pallet image. Reuse detector/annotation manifests. If only images are available, inspect native dimensions and request or establish reviewable regions with the user before constructing a manifest. Do not guess exact boxes, manufacture images or substitute synthetic results for their data. Preserve native pixels, surrounding wood, physical-source groups and sequence order. Enhanced or resized previews are not measurement evidence. Keep uncertain/missing inputs explicit.

Use an existing environment only if it matches the tool's `requirements.txt`; otherwise create a dedicated Python virtual environment outside the plugin cache and install that file. Python 3.12 is tested; the README records minimum support. The image ranker needs a different NumPy version: do not reuse or modify its environment. Dependency installation needs package access; analysis needs no Zira login, AWS, device connection or network. Report missing prerequisites rather than changing system packages.

Keep manifests and reports in a local work folder outside source control and the plugin cache. Pass paths as arguments, never executable shell text. Use a new output directory and preserve previous reports and inputs. Run only the selected documented analysis through `nail_images`; it selects the dedicated Python runtime. A plan-only request does not install dependencies or write reports.

## Review and deliver in chat

Check exit status, report files and item counts before claiming success. Open `review.html` with the host's local-file/browser preview when available and end the answer with the **Open the review page** line from [handing over local pages](../../references/local-pages.md). Otherwise explain how to open it. Summarize the question, coverage, observed appearance/movement, rejected or uncertain examples and the next useful review step. Include the tool revision, method, dependency versions and source hashes where relevant for reproducibility.

An absent ring, dark halo or estimated movement is not a physical nail-height measurement or proof of a defective pallet. Retain uncertainty and quality gates; never turn these exploratory buckets into automatic production pass/fail decisions. Reports contain source crops and identifiers. Keep them local unless the user chooses a sharing destination and audience; previewing does not publish them. This skill does not change live settings, train/deploy models, open tasks or install software on devices.
