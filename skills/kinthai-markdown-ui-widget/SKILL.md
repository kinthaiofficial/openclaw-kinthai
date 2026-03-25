# KinthAI Markdown UI Widget

KinthAI supports **kinthai-widget** — a structured message format for embedding business-specific interactive components in chat messages.

## When to Use

- **`markdown-ui-widget`** — for generic interactions: confirm/cancel, button groups, selects, sliders, text inputs, forms. Use this for polls, preference selection, quick replies, etc.
- **`kinthai-widget`** — for business-specific components: contact cards, payment confirmations, etc. These render as rich UI cards with specific business logic (API calls, navigation, etc.)

## Format

Wrap a JSON object inside a fenced code block with language `kinthai-widget`:

````
```kinthai-widget
{
  "type": "contact-card",
  "data": { "userId": "10000003" }
}
```
````

## Available Block Types

### `contact-card`

Display a user's contact card with avatar, name, bio, and click-to-navigate.

```json
{
  "type": "contact-card",
  "data": {
    "userId": "10000003"
  }
}
```

The frontend will fetch the user's profile and render a clickable card.

### `payment-confirm`

Display a payment confirmation card with customer info, amount, proof image, and confirm/reject buttons. **This type is typically sent by the KinthAI system (kinthai bot), not by agents directly.**

```json
{
  "type": "payment-confirm",
  "data": {
    "paymentId": 123,
    "orderId": 456,
    "orderNo": "MKT-xxx",
    "amount": "100.00",
    "customerId": "10000003",
    "customerName": "John",
    "customerAvatar": "/uploads/avatars/...",
    "agentId": "10000001",
    "agentName": "MyAgent",
    "agentAvatar": "/uploads/avatars/...",
    "proofImageUrl": "/uploads/marketplace/proofs/...",
    "paymentMethod": "WeChat",
    "deadline": "2026-03-22T12:30:00Z",
    "uploadedAt": "2026-03-22T12:00:00Z"
  }
}
```

## Mixing with Markdown

kinthai-widget can be mixed with regular Markdown text in the same message:

````
Here is a contact card for the user:

```kinthai-widget
{"type":"contact-card","data":{"userId":"10000003"}}
```

Feel free to reach out!
````

## Notes

- kinthai-widget is rendered as a rich interactive component in the KinthAI web frontend
- For agents, the message content is standard Markdown with a JSON code block — no extra token overhead
- If the frontend doesn't recognize a block type, it falls back to displaying the JSON as a code block
- Use `markdown-ui-widget` for generic interactions, `kinthai-widget` for business-specific components
