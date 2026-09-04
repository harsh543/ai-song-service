import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(__dirname, "public")));

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const MAX_MUSIC_LENGTH_MS = 60_000; // keep generations short: cost + webhook timeout budget

if (!ELEVENLABS_API_KEY) {
	console.error("Missing ELEVENLABS_API_KEY env var.");
	process.exit(1);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// Asks Gemini for short, singable lyrics for the given theme. Returns null (rather than
// throwing) on any failure so callers can fall back to prompt-only generation instead of
// failing the whole request over an optional enhancement.
async function writeLyrics(theme) {
	if (!GEMINI_API_KEY) return { lines: null, reason: "GEMINI_API_KEY not set" };
	try {
		const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
			method: "POST",
			headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gemini-3.8-flash",
				input: `Write short, singable song lyrics for a song described as: "${theme}".
Return exactly 8 short lines, no verse/chorus labels, no explanation, no quotes -- just the 8 lines, one per line.`,
			}),
		});
		if (!response.ok) {
			const detail = await response.text();
			return { lines: null, reason: `Gemini HTTP ${response.status}: ${detail.slice(0, 200)}` };
		}
		const data = await response.json();
		// Response shape is { steps: [...] }, not a top-level output_text -- the actual
		// text lives in whichever step has type "model_output".
		const modelOutput = data.steps?.find((s) => s.type === "model_output");
		const text = modelOutput?.content?.find((c) => c.type === "text")?.text;
		if (!text) return { lines: null, reason: `no text in Gemini response: ${JSON.stringify(data).slice(0, 200)}` };
		const lines = text
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.slice(0, 8);
		if (!lines.length) return { lines: null, reason: "Gemini returned text with no usable lines" };
		return { lines, reason: null };
	} catch (error) {
		return { lines: null, reason: `writeLyrics threw: ${error.message}` };
	}
}

// Core capability: given a text prompt, return a generated song as audio bytes. When
// Gemini is available, writes real lyrics first and hands ElevenLabs a composition_plan
// (actual sung lines) instead of just a vibe description.
async function generateSong(prompt, musicLengthMs) {
	const clampedLength = Math.min(Math.max(Number(musicLengthMs) || 30_000, 3_000), MAX_MUSIC_LENGTH_MS);
	const { lines: lyrics, reason: lyricsFailureReason } = await writeLyrics(prompt);

	const body = lyrics
		? {
				composition_plan: {
					positive_global_styles: [prompt],
					negative_global_styles: [],
					sections: [
						{
							section_name: "Verse",
							positive_local_styles: [prompt],
							negative_local_styles: [],
							duration_ms: Math.round(clampedLength / 2),
							lines: lyrics.slice(0, 4),
						},
						{
							section_name: "Chorus",
							positive_local_styles: [prompt],
							negative_local_styles: [],
							duration_ms: clampedLength - Math.round(clampedLength / 2),
							lines: lyrics.slice(4, 8),
						},
					],
				},
				model_id: "music_v1",
			}
		: { prompt, music_length_ms: clampedLength, model_id: "music_v2" };

	const response = await fetch("https://api.elevenlabs.io/v1/music", {
		method: "POST",
		headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const detail = await response.text();
		throw Object.assign(new Error("Song generation failed upstream."), { detail, upstream: true });
	}

	return { audio: Buffer.from(await response.arrayBuffer()), lyrics, lyricsFailureReason };
}

app.post("/generate-song", express.json(), async (req, res) => {
	const { prompt, musicLengthMs } = req.body ?? {};
	if (!prompt || typeof prompt !== "string") {
		return res.status(400).json({ error: "Body must include a string `prompt`." });
	}

	try {
		const { audio, lyrics, lyricsFailureReason } = await generateSong(prompt, musicLengthMs);
		if (lyrics) res.set("X-Lyrics", encodeURIComponent(lyrics.join(" / ")));
		else if (lyricsFailureReason) res.set("X-Lyrics-Skipped-Reason", encodeURIComponent(lyricsFailureReason));
		res.set("Content-Type", "audio/mpeg");
		res.set("Content-Disposition", 'attachment; filename="song.mp3"');
		res.send(audio);
	} catch (error) {
		console.error("generate-song failed", error);
		if (error.upstream) return res.status(502).json({ error: error.message, detail: error.detail });
		res.status(500).json({ error: "Unexpected server error." });
	}
});

// Video: kicks off a Veo generation job, polls until it's done, then streams the mp4
// bytes back. Veo is async (unlike ElevenLabs' music endpoint), so this single request
// blocks for the duration of generation -- expect 30s-3min depending on load.
app.post("/generate-video", express.json(), async (req, res) => {
	if (!GEMINI_API_KEY) {
		return res.status(500).json({ error: "GEMINI_API_KEY not configured." });
	}
	const { prompt, durationSeconds } = req.body ?? {};
	if (!prompt || typeof prompt !== "string") {
		return res.status(400).json({ error: "Body must include a string `prompt`." });
	}
	const duration = Math.min(Math.max(Number(durationSeconds) || 6, 4), 8);

	try {
		const startRes = await fetch(
			"https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
			{
				method: "POST",
				headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
				body: JSON.stringify({
					instances: [{ prompt }],
					parameters: { aspectRatio: "16:9", resolution: "720p", durationSeconds: duration },
				}),
			},
		);
		if (!startRes.ok) {
			const detail = await startRes.text();
			console.error("Veo start error", startRes.status, detail);
			return res.status(502).json({ error: "Video generation failed to start.", detail });
		}
		const { name: operationName } = await startRes.json();
		if (!operationName) {
			return res.status(502).json({ error: "No operation name returned by Veo." });
		}

		const deadline = Date.now() + 4 * 60_000;
		let op;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5000));
			const pollRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${operationName}`, {
				headers: { "x-goog-api-key": GEMINI_API_KEY },
			});
			if (!pollRes.ok) {
				console.error("Veo poll error", pollRes.status, await pollRes.text());
				continue;
			}
			op = await pollRes.json();
			if (op.done) break;
		}

		if (!op || !op.done) {
			return res.status(504).json({ error: "Video generation timed out." });
		}
		if (op.error) {
			return res.status(502).json({ error: "Video generation failed.", detail: op.error });
		}

		const videoUri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
		if (!videoUri) {
			return res.status(502).json({ error: "No video URI in completed operation.", detail: op });
		}

		const videoRes = await fetch(videoUri, { headers: { "x-goog-api-key": GEMINI_API_KEY } });
		if (!videoRes.ok) {
			return res.status(502).json({ error: "Failed to download generated video." });
		}
		const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
		res.set("Content-Type", "video/mp4");
		res.set("Content-Disposition", 'attachment; filename="video.mp4"');
		res.send(videoBuffer);
	} catch (error) {
		console.error("generate-video failed", error);
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
