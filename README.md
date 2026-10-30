# Voice Studio

A browser dashboard that does what your WhatsApp bot does, but you **speak** instead of
sending WhatsApp messages. Speech becomes a transcript, the transcript goes to the same
Agentic API the bot calls, the design preview shows up on screen, and **Approve** hands it back
to Agentic to publish (same `APPROVE_ALL` call the bot makes).

## Run

```bash
cd studio
npm install
cp .env.example .env     # then fill in the two values below
npm start
```
Open http://localhost:3002 in **Chrome or Edge** (needed for speech-to-text).

`.env` (use the same values as your WhatsApp bot):
```
AGENTIC_API_URL=https://your-agentic-service.onrender.com
INTERNAL_SERVICE_TOKEN=your-internal-token
```

## One setup step: where Agentic sends previews
Agentic pushes finished designs to a URL. For the bot that is
`<bot>/whatsapp/integrations/agentic/previews`. For dashboard conversations it must reach this server:

* This server accepts previews at **`/integrations/agentic/previews`** (and the same
  `/whatsapp/integrations/agentic/previews` path as the bot, so you only change the host).
* Running locally, expose it with a tunnel, e.g. `npx localtunnel --port 3002` or `ngrok http 3002`,
  and give Agentic that public URL.
* It only accepts previews whose `merchantId` is `dashboard` (`DASHBOARD_MERCHANT_ID`), so
  your WhatsApp conversations keep going to the bot.
* If you set `DASHBOARD_TOKEN`, the dashboard asks for it; with none set the server only
  listens on 127.0.0.1.

## What maps to what
| Dashboard | Same as WhatsApp |
|---|---|
| Speak / type + photo, Send | text or image message -> `POST /api/integrations/whatsapp/messages` |
| Agent asks a question (tap an option or speak) | `clarification_required`, answer sent with `questionId` + `productDraftId` |
| Design appears in Review | Agentic preview handoff (`design.preview_ready`) |
| Approve & publish | `POST .../jobs/:id/feedback` `APPROVE_ALL` |
| Request changes (typed or spoken) | `EDIT_SELECTED` with your notes, new version comes back |

Failed calls retry automatically with backoff (up to 6 times), like the bot's worker.
