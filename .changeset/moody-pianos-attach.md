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
