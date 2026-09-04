import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(__dirname, "public")));

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const MAX_MUSIC_LENGTH_MS = 60_000; // keep generations short: cost + webhook timeout budget

if (!ELEVENLABS_API_KEY) {
	console.error("Missing ELEVENLABS_API_KEY env var.");
	process.exit(1);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// Core capability: given a text prompt, return a generated song as audio bytes.
// This is the piece every other endpoint (Shopify webhook, manual testing) builds on.
app.post("/generate-song", express.json(), async (req, res) => {
	const { prompt, musicLengthMs } = req.body ?? {};
	if (!prompt || typeof prompt !== "string") {
		return res.status(400).json({ error: "Body must include a string `prompt`." });
	}

	const clampedLength = Math.min(Math.max(Number(musicLengthMs) || 30_000, 3_000), MAX_MUSIC_LENGTH_MS);

	try {
		const response = await fetch("https://api.elevenlabs.io/v1/music", {
			method: "POST",
			headers: {
				"xi-api-key": ELEVENLABS_API_KEY,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				prompt,
				music_length_ms: clampedLength,
				model_id: "music_v2",
			}),
		});

		if (!response.ok) {
			const detail = await response.text();
			console.error("ElevenLabs error", response.status, detail);
			return res.status(502).json({ error: "Song generation failed upstream.", detail });
		}

		const audioBuffer = Buffer.from(await response.arrayBuffer());
		res.set("Content-Type", "audio/mpeg");
		res.set("Content-Disposition", 'attachment; filename="song.mp3"');
		res.send(audioBuffer);
	} catch (error) {
		console.error("generate-song failed", error);
		res.status(500).json({ error: "Unexpected server error." });
	}
});

// Shopify calls this when an order is paid. Verifies the request actually came from
// Shopify (HMAC over the raw body, using the webhook secret) before doing anything
// that costs money -- without this, anyone could hit this URL and rack up generation
// bills on your ElevenLabs account.
app.post(
	"/webhook/order-paid",
	express.raw({ type: "application/json" }),
	async (req, res) => {
		if (!SHOPIFY_WEBHOOK_SECRET) {
			console.error("SHOPIFY_WEBHOOK_SECRET not set -- refusing to process webhook.");
			return res.status(500).send("Webhook not configured.");
		}

		const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
		const digest = crypto
			.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
			.update(req.body)
			.digest("base64");

		if (!hmacHeader || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader))) {
			return res.status(401).send("Invalid signature.");
		}

		const order = JSON.parse(req.body.toString("utf8"));
		// TODO once the Shopify product's line-item property name is finalized: pull the
		// customer's prompt out of order.line_items[0].properties, call the same
		// generation logic as /generate-song, then deliver the file (email link, upload
		// to storage, etc.). Left unimplemented on purpose -- wiring this to a real
		// delivery mechanism is a decision, not a default.
		console.log("Received paid order", order.id, "-- fulfillment not yet wired up.");
		res.status(200).send("ok");
	},
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ai-song-service listening on :${port}`));
