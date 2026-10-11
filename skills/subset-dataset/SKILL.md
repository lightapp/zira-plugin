---
name: subset-dataset
description: Create a smaller Zira dataset from a dataset version with at least N images of each chosen class (an image with several classes counts for each), keeping train/val/test populated, and add it to Zira as a new dataset. Use for "make a subset with 100 raisedNail images", "balance this dataset by class", or "a smaller dataset with at least 50 of each class"; not for evaluating a model (evaluate-model) or opening a dataset (open-dataset).
---

Check [build restrictions and prerequisites](../../references/distribution.md) first. Public builds support `.tflite` models only; do not offer `.pt` setup or execution even if another local environment has PyTorch installed.


Read [authorized browsing](../../references/browsing.md) (including "Asking the user to choose") and [guided actions](../../references/actions.md). Run `node ../../scripts/datasets.mjs …`, `node ../evaluate-model/scripts/evaluate.mjs …` and `node scripts/subset.mjs …` from this skill's directory with the same `--profile`. The subset is built on this computer; the only change in Zira is the new dataset the user adds.

**Show, then work.** As soon as the camera is known, open its Datasets tab (`views.datasets.url`) with the host's browser tool and say what you are doing next.

1. **Camera, dataset and version.** Resolve the camera with `datasets.mjs find --place … --source …` (or a pasted link). Ask which dataset (dataset `question`) and use its newest version unless the user names one (`datasets --dataset NAME` → `versionQuestion`).
2. **Get the version:** `evaluate.mjs status` (if not ready, ask once and run `evaluate.mjs setup`), then `evaluate.mjs fetch --device-id ID --file-id VERSION_ID`.
3. **Targets.** Turn the request into `--min "class=N,…"` with the dataset's class names (`all=N` for every class). Targets count images containing the class, not boxes. If the user gave no numbers, ask for them.
4. **Preview, then confirm:** `subset.mjs preview --dataset ZIP --min SPEC`. Show a short per-class table (requested, available, images selected, train/val/test) and the total, mention overshoot (classes that ride along in chosen images) and any `shortfalls`, then ask the returned `question` (create / use what's available / change the numbers). `--split-mode keep` ignores splits if the user asks.
5. **Create:** ask for the new dataset name if not given (suggest `<source>-subset`), then `subset.mjs create --dataset ZIP --min SPEC --name NAME --device-id ID --version-id VERSION_ID [--use-available]`. It writes `NAME.zip` to Downloads with a manifest of the source and selection.
6. **Add it to Zira.** Preview the upload: `subset.mjs upload --file ZIP --name NAME --device-id ID`. Show what will be added (camera, dataset name, size), confirm, then rerun with `--apply`: it uploads the ZIP once (a receipt prevents repeats), waits for Zira to attach it and starts the import. Say the import takes a few minutes, then refresh the Datasets tab to confirm it.
   - `upload_not_enabled`: Zira doesn't allow agent uploads for this sign-in yet; nothing was uploaded. The Datasets tab is already open: navigate to `manual.pageUrl` if needed and walk the user through `manual.steps` (+ Add dataset → name → Upload dataset version (ZIP) → Choose ZIP file → Create).
   - `unverified_write` or `partial_write`: the ZIP was uploaded but the import did not start or could not be confirmed. Show the links, don't rerun; the ZIP version is on the camera and can be turned into a dataset from the Datasets tab.

Say the dataset was created only after the import was started (`state: created`) or the user completed the manual upload, and confirm it on the Datasets tab. Never overwrite or change the source dataset.
