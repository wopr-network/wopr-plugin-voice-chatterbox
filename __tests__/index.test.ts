import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock global fetch before importing the module
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// We need to import after mocking
const { default: plugin } = await import("../index.js");

// Helper: create a minimal WAV buffer
function makeWavBuffer(pcmBytes: number): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcmBytes, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // chunk size
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(24000, 24); // sample rate
	header.writeUInt32LE(48000, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36);
	header.writeUInt32LE(pcmBytes, 40);
	return Buffer.concat([header, Buffer.alloc(pcmBytes)]);
}

interface MockLog {
	info: ReturnType<typeof vi.fn>;
	error: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
	debug: ReturnType<typeof vi.fn>;
}

interface MockCtx {
	log: MockLog;
	getConfig: () => { serverUrl: string };
	registerExtension: ReturnType<typeof vi.fn>;
	registerCapabilityProvider: ReturnType<typeof vi.fn>;
}

interface SynthesizeResult {
	format: string;
	sampleRate: number;
}

interface MockProvider {
	synthesize(
		text: string,
		opts?: Record<string, unknown>,
	): Promise<SynthesizeResult>;
}

function mockCtx(): MockCtx {
	return {
		log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
		getConfig: () => ({ serverUrl: "http://localhost:5123" }),
		registerExtension: vi.fn(),
		registerCapabilityProvider: vi.fn(),
	};
}

function makeArrayBuffer(buf: Buffer): ArrayBuffer {
	return buf.buffer.slice(
		buf.byteOffset,
		buf.byteOffset + buf.byteLength,
	) as ArrayBuffer;
}

describe("ChatterboxProvider", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("synthesizes without referenceAudio (default path unchanged)", async () => {
		const wavBuf = makeWavBuffer(100);

		// Health check
		mockFetch.mockResolvedValueOnce({ ok: true });
		// Voices
		mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
		// Synthesize (OpenAI-compat endpoint)
		mockFetch.mockResolvedValueOnce({
			ok: true,
			arrayBuffer: async () => makeArrayBuffer(wavBuf),
		});

		const ctx = mockCtx();
		await plugin.init?.(ctx as Parameters<NonNullable<typeof plugin.init>>[0]);

		// Get the registered provider
		const provider = ctx.registerExtension.mock.calls[0][1] as MockProvider;
		const result = await provider.synthesize("Hello world");

		expect(result.format).toBe("pcm_s16le");
		expect(result.sampleRate).toBe(24000);

		// Should NOT have used FormData (no multipart)
		const synthCall = mockFetch.mock.calls[2];
		expect(synthCall[0]).toContain("/v1/audio/speech");
	});

	it("synthesizes with referenceAudio (cloning path)", async () => {
		const wavBuf = makeWavBuffer(100);
		const refAudio = Buffer.from("fake-reference-audio");

		// Health check
		mockFetch.mockResolvedValueOnce({ ok: true });
		// Voices
		mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
		// Clone synthesize
		mockFetch.mockResolvedValueOnce({
			ok: true,
			arrayBuffer: async () => makeArrayBuffer(wavBuf),
		});

		const ctx = mockCtx();
		await plugin.init?.(ctx as Parameters<NonNullable<typeof plugin.init>>[0]);

		const provider = ctx.registerExtension.mock.calls[0][1] as MockProvider;
		const result = await provider.synthesize("Hello clone", {
			referenceAudio: refAudio,
		});

		expect(result.format).toBe("pcm_s16le");

		// Should have used /synthesize with FormData
		const synthCall = mockFetch.mock.calls[2];
		expect(synthCall[0]).toContain("/synthesize");
		expect(synthCall[1].body).toBeInstanceOf(FormData);
	});

	it("falls back to default voice when no referenceAudio", async () => {
		const wavBuf = makeWavBuffer(100);

		mockFetch.mockResolvedValueOnce({ ok: true });
		mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
		mockFetch.mockResolvedValueOnce({
			ok: true,
			arrayBuffer: async () => makeArrayBuffer(wavBuf),
		});

		const ctx = mockCtx();
		await plugin.init?.(ctx as Parameters<NonNullable<typeof plugin.init>>[0]);

		const provider = ctx.registerExtension.mock.calls[0][1] as MockProvider;
		const result = await provider.synthesize("No clone here", {});

		expect(result.format).toBe("pcm_s16le");
		// Default path — should use /v1/audio/speech
		const synthCall = mockFetch.mock.calls[2];
		expect(synthCall[0]).toContain("/v1/audio/speech");
	});

	it("passes exaggeration and cfgWeight overrides", async () => {
		const wavBuf = makeWavBuffer(100);
		const refAudio = Buffer.from("ref");

		mockFetch.mockResolvedValueOnce({ ok: true });
		mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
		mockFetch.mockResolvedValueOnce({
			ok: true,
			arrayBuffer: async () => makeArrayBuffer(wavBuf),
		});

		const ctx = mockCtx();
		await plugin.init?.(ctx as Parameters<NonNullable<typeof plugin.init>>[0]);

		const provider = ctx.registerExtension.mock.calls[0][1] as MockProvider;
		await provider.synthesize("Custom params", {
			referenceAudio: refAudio,
			exaggeration: 0.9,
			cfgWeight: 0.3,
		});

		const synthCall = mockFetch.mock.calls[2];
		// Verify it hit the clone endpoint
		expect(synthCall[0]).toContain("/synthesize");
	});
});
