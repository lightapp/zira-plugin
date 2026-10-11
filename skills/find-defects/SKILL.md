---
name: find-defects
description: Find rare defect examples such as raised nails among a Pallet Vision camera's nail slices, let a person review the candidates on a local page with the keyboard, and turn the accepted ones into a dataset or a corrected version of a training dataset. Works on recent QA sessions (new examples) or a dataset version (labels to fix). Use for "find more raised nails", "mine the validation sessions for raisedNail", or "which nails in sample-nails-v10.7 are really raised nails"; not for scoring a model (evaluate-model) or annotating in Zira (open-dataset).
---

Check [build restrictions and prerequisites](../../references/distribution.md) first. Public builds support `.tflite` models only; do not offer `.pt` setup or execution even if another local environment has PyTorch installed.


Read [authorized browsing](../../references/browsing.md) (including "Asking the user to choose") and [guided actions](../../references/actions.md). Run `node ../../scripts/datasets.mjs …`, `node ../evaluate-model/scripts/evaluate.mjs …`, `node ../evaluate-model/scripts/sessions.mjs …` and `node scripts/defects.mjs …` from this skill's directory with the same `--profile`. Everything runs on this computer. The only change in Zira is a dataset the user chooses to upload.

**Show, then work.** As soon as the camera is known, open its Models tab with the host's browser tool and say what comes next.

1. **Where to look.** Skip this when the request says. Otherwise ask: *Recent QA sessions* (new examples from the line; Pallet Vision) / *A dataset version* (find boxes labeled as something else, for example nails that are raised nails).
2. **Finder model.** The finder needs a model trained with the defect class (`--target`, default `raisedNail`; ask which class for another defect).
   - List the camera's models with `datasets.mjs datasets --device-id ID --dataset NAME` and pick one whose classes include the target. A model that was not good enough for production still works here: it only proposes, and a person decides.
   - Fetch it with `evaluate.mjs fetch --device-id ID --file-id MID`. If Zira recorded no classes for it, ask for them and pass `--model-classes`.
3. **Slices.**
   - **Sessions:** `sessions.mjs list` → ask its `question`, then `sessions.mjs fetch` (with `needsConfirmation`, say the frames and MB and ask; more sessions find more examples), then `sessions.mjs prepare --outputs nails`. Without `--classes-from`, it keeps the platform's class order, which includes raisedNail.
   - **Dataset version:** `evaluate.mjs fetch --file-id VERSION_ID` and use the ZIP path.
   - `sessions_unavailable`: session downloads are not enabled in this environment yet. Offer a dataset version instead.
4. **Runtime, once:** `evaluate.mjs status`; if not ready, ask once and run `evaluate.mjs setup`.
5. **Scan:** `defects.mjs scan --dataset PATH --model FILE [--target CLASS[,CLASS…]] [--confidence 0.05]`. QA sessions are large (a day can hold 3,000 frames) and a finder model proposes many candidates there; slices are ranked by score, so the person reviews from the top and stops when hits get rare. A low confidence finds more, and the person filters. Report `totals`: slices to review, candidate boxes, slices a reviewer marked as a nails defect, and examples already labeled. With nothing to review, offer more sessions or a lower confidence.
6. **Review:**
   - Start `defects.mjs review --device-id ID --run RUN --open` as a background process and open its `url` with the host's browser tool. With `--device-id`, the page also lists the camera's dataset versions, QA sessions and the site's models that know the class, so the person sees what was chosen, can change it and start another search there, and can reopen earlier searches. Without a run yet, start the page with `--device-id` alone and let the person choose.
   - The page explains itself: what to do, where the orange boxes come from (the finder model's guesses with their confidence), where the blue ones come from (the dataset version's labels, or the device's detections and reviewer corrections for QA sessions), and why each slice is shown. Keys: 1–N label, 0/R not this, S unsure, U undo, Tab next box, ←/→ move. It shows the slice, an unmarked close-up, the pallet frame (F), reviewer marks, and how to tell the classes apart.
   - Unsure: when the person can't tell from the image, they press S. Unsure slices stay out of exports (`--keep-unsure` keeps them with their current labels) and can be listed for a second look in the page's Unsure view.
   - Decisions save as they are made, and the page keeps its address when it is started again. Background processes can be stopped by the host, so when the person comes back or the page stops answering, start the same command again. End the answer with the **Open the review page** line from [handing over local pages](../../references/local-pages.md).
   - Never make decisions for the person. Check `defects.mjs progress --run RUN` when they ask how far they are.
7. **Export,** when they are done or want a checkpoint:
   - New examples: `defects.mjs export --run RUN --name NAME --zip` writes the accepted slices, with every other nail labeled as before, to `NAME.zip` in Downloads. Hard negatives and relabels need `--all-reviewed`. Report `unsureLeftOut` when there are any.
   - Corrected training set: add `--whole` for every slice of the scanned version, with the decisions applied and splits kept.
   - Show the `upload` steps on the camera's Datasets tab, and say to merge new examples with the training dataset in Zira before training. Nothing is uploaded unless the user does it.
8. **Answer briefly:**
   - Accepted and reviewed counts, and where the dataset is.
   - Exported labels other than the accepted defect are the reference: reviewer corrections where present, otherwise device output.
   - Next steps: train with the same architecture as the production model, then compare it with evaluate-model on fresh QA sessions.

Say "found" only for candidates a person accepted. The finder's scores are not detections.
