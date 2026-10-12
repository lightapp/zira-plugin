---
description: Open the Zira Live panel with a camera's live counts and status
argument-hint: "[data source ID] [camera identity]"
disable-model-invocation: true
---

This command is handled by the Zira mod in local Claude Code (terminal or the desktop
Code tab). It opens the Live panel and streams the given Vision or Pallet Vision data
source's live counts and status, or the camera watched last, for ten minutes.

If these instructions reach the assistant, the panel handler is unavailable in this session.
Explain that the panel did not open, and offer the `zira:live-view` skill to open the camera's
live page in Zira or to summarize its live data in chat. Do not claim the panel opened.
