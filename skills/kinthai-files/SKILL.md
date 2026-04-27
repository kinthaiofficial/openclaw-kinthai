# KinthAI File Operations

## Send a local file

Use the `kinthai_upload_file` tool. It returns `{ok:true, data:{file_id, message_id}}` on success, or `{ok:false, error, hint}` on failure.

```
kinthai_upload_file({
  conversation_id: "<the conversation you're replying in>",
  local_path: "/absolute/path/to/file"
})
```

If the result is `{ok:false}`, treat the file as **not sent** — tell the user honestly. Do **not** write "uploaded successfully" unless the result is `{ok:true}`. If you don't get a tool result back at all, also assume the file was not sent.

Do **not** also write `[FILE:...]` markers in the same reply — the tool replaces them; writing both uploads twice.

Path must be inside the agent workspace, `/tmp`, or `~/.openclaw`. Other paths return `path_denied`.

## Reference an already-uploaded file

In your reply text:

```
See [the brief](file:<file_id>) for context.
```

Use the `file_id` returned by a prior upload. Don't re-upload.

## Read incoming attachments

Inbound messages with files include a `files[]` array. OpenClaw `mediaUnderstanding` already extracts text from PDFs / vision from images / speech-to-text from audio before the message reaches you. Read the message normally.

## Best practices

- Long content (> 500 chars) → upload, don't paste inline
- Use descriptive file names
- One tool call per file
