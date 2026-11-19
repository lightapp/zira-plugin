# Zira plugins and where a skill lives

Zira comes as separate plugins from the same marketplace, so each person installs only what they use.
All of them share one Zira sign-in and the same saved preferences.

| Plugin | For | Skills |
| --- | --- | --- |
| **Zira** (`zira`) | Everyone: ask about sites, cameras, production, reports, dashboards, tasks, forms and data sources | Everything in this plugin's skill list |
| **Zira Vision** (`zira-vision`) | People who build and check AI vision: models, datasets and image analysis | `evaluate-model`, `find-defects`, `subset-dataset`, `inspect-nail-images` |

Python is needed only for Zira Vision and for the trimsaw camera-view check; each sets up its own
environment after the user agrees.

## When a skill named in a recipe is not installed

A skill of another plugin is available only when that plugin is installed in this app. If the skill
is missing from the session's skill list, do not imitate it with shell commands or a browser:

1. Say in one line which plugin has it ("Evaluating a model is part of the Zira Vision plugin").
2. Offer to add it. It comes from the same `zira` marketplace the user already has:
   - Claude Code: `claude plugin marketplace update zira`, then `claude plugin install zira-vision@zira`
   - Codex: `codex plugin add zira-vision@zira` after the marketplace is current
   For an installation made from the public ZIP, follow the update steps in [setup help](setup-help.md)
   first so the marketplace folder contains the plugin. The guided page is <https://help.zira.us/ai-plugins>.
3. After it is installed, the user starts a new chat; continue there.

Zira Vision expects the Zira plugin next to it for finding sites, cameras and datasets by name.
