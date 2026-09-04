# AI Song & Video Generator

A small Express service that turns a text description into a real generated song (written lyrics + sung vocals) or a real generated video. No mock data, no samples -- every response is a fresh call to the underlying models.

**Live:** https://ai-song-service.onrender.com

## How it works

1. **Lyrics** -- [Gemini](https://ai.google.dev/gemini-api) writes short, singable lyrics from your description.
2. **Song** -- [ElevenLabs Music](https://elevenlabs.io/eleven-music-api) sings those lyrics over a generated instrumental. The voice is a generic AI voice, not modeled on any real singer; ElevenLabs' music model is trained on licensed stems through direct deals with artists/labels/publishers.
3. **Video** -- [Veo 3.1](https://ai.google.dev/gemini-api/docs/veo) generates a short video from a scene description. This is a real async job (kicked off, then polled until done), so expect 1-3 minutes, not seconds.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/generate-song` | `{ prompt: string, musicLengthMs?: number }` | `audio/mpeg` bytes |
| `POST` | `/generate-video` | `{ prompt: string, durationSeconds?: number }` | `video/mp4` bytes |
| `GET` | `/health` | -- | `{ ok: true }` |
| `POST` | `/webhook/order-paid` | Shopify order webhook payload | HMAC-verified; fulfillment logic not yet wired to a specific product |

`GET /` serves a small browser UI for both generators.

## Running locally

```bash
npm install
cp .env.example .env   # fill in ELEVENLABS_API_KEY and GEMINI_API_KEY
npm start
```

## Stack

Node.js, Express, the ElevenLabs Music API, and the Gemini API (text + Veo video).
