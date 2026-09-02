---
"@appx-org/agent-server": minor
"@appx-org/agent-protocol": minor
"@appx-org/agent-client": minor
---

Add chat attachments. `POST /v1/projects/{id}/attachments` uploads an opaque
file (JSON base64) into the project workspace at `attachments/<id>/<filename>`;
`POST …/sessions/{id}/prompt` accepts an optional `attachments` id array and
appends the stored workspace paths to the prompt so the agent can read the
files with its own tools when needed. agent-client gains
`AgentClient.uploadAttachment`, an `attachments` parameter on `sendPrompt`, and
an attach button + pending-attachment chips in `ChatPanel`.

Upload limits are enforced as an HTTP body limit (~25 MB per file) plus a 200 MB
per-project quota, both returning `413`; base64 is validated strictly so a
truncated payload can't be stored as a silently corrupt file; zero-byte files
are accepted; and long multibyte filenames are truncated by UTF-8 byte length
instead of failing with `ENAMETOOLONG`. The prompt's attachment note is wrapped
in `<attached-files>` delimiters that agent-client strips from the rendered user
message, showing the attached filenames as chips instead of the internal note.
