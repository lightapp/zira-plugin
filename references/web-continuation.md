# Continue a workflow in Zira

Use this when a helper returns a `handoff` (for example `blocked: authorization`), when a step lives in a Zira visual editor, or when the user prefers to finish in the web app. Say what was and was not done in chat, then offer the continuation.

Use the helper's `handoff` when present. Otherwise resolve `node ../../scripts/browse.mjs menu --profile prod` from the invoking skill directory (or `integ` only when selected in an internal build). It makes no API calls and returns the environment's `assistantUrl`. Offer a specific `pageUrl` returned by a helper before the generic assistant. Give the action-specific prompt from the skill with the details already gathered. Open a link with the host browser tool only when requested.

The URL opens the page but does not submit a prompt, transfer this conversation, or preselect a site. Tell the user to select the same company/site there. Do not put private data or credentials into URL query parameters; helper links contain only IDs and the site name the editor needs. Opening a page is not proof of a created task, dashboard, data source, form, device configuration or schedule. Do not call the web assistant's cookie-authenticated server routes from the plugin.

For a user who wants everything in chat, explain the specific gap (for example, that API is not yet enabled for plugin sign-in) and preserve their details for the handoff. Do not claim an operation or schedule was completed without a verified helper result.
