---
name: setup-vision
description: Guide setup of a Zira Vision or Pallet Vision device step by step, from pairing and mounting through recording, datasets, training and validation, with links to the right Zira tabs. Use for setup, not a fleet health check or Android development.
---

Read [authorized browsing](../../references/browsing.md) and [guided actions](../../references/actions.md). This follows the Home Assistant vision workflow.

1. **Choose the device.** Reuse the company, site and data source. Otherwise run `node ../../scripts/vision.mjs list --company-id ID --site-id ID --profile prod`. One result: use it. Several: ask which. None: offer create-data-source (Vision or Pallet QA template).
2. **Next step.** Run `vision.mjs status --company-id ID --site-id ID --device-id ID`. Lead with `nextStep.title` and `body`, then its links (Overview for QR / one-time-code pairing, Remote Control for live view and recording, Videos, Datasets, Models, Validation). Include `evidence` such as the last signal and camera flags. For `prepare_dataset`, walk through the `checklist` in order and ask where the user is.
3. **Unknowns.** `notReadableHere` lists progress the plugin cannot read (recordings, datasets, annotations, splits, validation sessions). Ask the user to confirm those in Zira; never report them as zero or done.
4. **Mark setup steps.** When the user says the device is paired or mounted, or chooses to skip that step, preview `vision.mjs mark … --step paired|skip-pairing|mounted|skip-mounting`, confirm, then rerun with `--apply` and continue from the returned `nextStep`. A heartbeat suggests, but does not prove, pairing; do not mark a step from a guess.

For `push_model_and_validate`, offer to evaluate the model on a dataset version first with the evaluate-model skill (per-class results with images, run on this computer). Repeat the status after each step the user completes. Marking a step records progress only; it does not pair, mount, record, train or deploy anything, and the plugin cannot control the camera. On `blocked: authorization` for a mark, the user can mark it on the data source's Overview tab. Fleet-wide device health uses health-report; building Android vision apps uses develop.
