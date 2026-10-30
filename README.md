# Voice Studio

Voice Studio is the dashboard transport for the Agentic image-design service. It follows the same product-brief, clarification, preview, revision, approval and publishing workflow as WhatsApp, while keeping dashboard and WhatsApp conversations completely separate.

The browser converts speech to an editable transcript. Agent replies, questions, preview notifications and publishing results are spoken back with the browser's selected voice. Product photos can be attached at the beginning of a brief.

This integration is image-only. It does not request, generate or publish video.

## Local run

```bash
npm install
copy .env.example .env
npm start
```

Open `http://localhost:3002` in Chrome or Edge and allow microphone access.

## Dashboard environment

```text
AGENTIC_API_URL=https://your-agentic-service.onrender.com
INTERNAL_SERVICE_TOKEN=the-same-private-token-used-by-agentic
DASHBOARD_TOKEN=a-password-for-opening-the-dashboard
DASHBOARD_MERCHANT_ID=dashboard
DATABASE_URL=postgresql://...
DATABASE_SSL=true
```

`DATABASE_URL` is strongly recommended on Render. It preserves conversations, draft references, previews, job history and idempotency state across redeployments. A request that was actively running during a restart is marked failed and can be resent safely. Without PostgreSQL, state is written under `DATA_DIR` and requires a persistent disk to survive a redeployment.

## Agentic environment

Keep the existing WhatsApp callback and add a separate dashboard callback:

```text
WHATSAPP_HANDOFF_URL=https://your-whatsapp-service/whatsapp/integrations/agentic/previews
DASHBOARD_HANDOFF_URL=https://your-dashboard-service/integrations/agentic/previews
INTERNAL_SERVICE_TOKEN=the-same-private-token-used-by-dashboard
VIDEO_POST_ENABLED=false
```

Do not replace `WHATSAPP_HANDOFF_URL` with the dashboard URL. Agentic routes each preview using the job's `sourceChannel`:

- WhatsApp job → WhatsApp only.
- Dashboard job → dashboard only.
- Approved final images are not sent back to WhatsApp or the dashboard.

## Voice workflow

1. Speak a product description and optionally attach a photo.
2. Agent questions are shown and spoken. Answer by speaking, typing or tapping an option.
3. The generated image arrives in Review and is announced by voice.
4. Speak a change such as “make the background dark blue” to request a revision.
5. Say “approve and publish”. Voice Studio asks for confirmation.
6. Say “confirm publish” to approve, export and publish to the selected image channels, or say “cancel”.

Spoken replies can be muted or replayed from the header. Recognition and speech currently use the browser Web Speech APIs, so Chrome or Edge is recommended.

## API mapping

| Dashboard action | Agentic API |
|---|---|
| Brief, clarification or product photo | `POST /api/integrations/dashboard/messages` |
| Approve and publish | `POST /api/integrations/dashboard/jobs/:id/feedback` with `APPROVE_ALL` |
| Request changes | The same feedback endpoint with `EDIT_SELECTED` |
| Receive preview | `POST /integrations/agentic/previews` on this service |

Failed Agentic calls retry with exponential backoff up to six attempts. Publishing remains centralized in Agentic, which records the Instagram and Facebook success or failure details returned to the dashboard.

## Render deployment

- Runtime: Node
- Build command: `npm ci`
- Start command: `npm start`
- Health check: `/health`
- Add a Render PostgreSQL database and copy its URL into `DATABASE_URL`.
- Deploy the dashboard first, then put its public preview URL into Agentic as `DASHBOARD_HANDOFF_URL` and redeploy Agentic.
