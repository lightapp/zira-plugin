# Zira Vision

AI vision tools for Zira, for people who build and check the models behind their cameras:
evaluate a model on your own images, find rare defect examples for human review, build dataset
subsets and analyse images on your computer.

Zira Vision is an add-on to the **Zira** plugin from the same marketplace. Install Zira first; it
finds your sites, cameras and datasets by name. Both plugins use the same Zira sign-in.

## Install

Guided setup: <https://help.zira.us/ai-plugins>. With the `zira` marketplace already added:

```sh
claude plugin install zira-vision@zira
codex plugin add zira-vision@zira
```

Start a new chat afterwards.

## What it needs

- A local Claude Code or Codex session on your computer, and Node.js 20+.
- Python 3.10+ for model evaluation, subsets, defect review and image analysis. Each feature
  builds its own pinned environment only after you agree.
- Your own Zira account. You see and change only what your account allows; writes show a preview first.

Public builds evaluate `.tflite` models only and sign in to Zira production only.
License, notices and data handling are the same as the Zira plugin's, in this repository's root.
