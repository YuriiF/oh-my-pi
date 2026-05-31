import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginXiaomi } from "../src/utils/oauth/xiaomi";

function fetchImplementation(
	handler: (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(handler, { preconnect: globalThis.fetch.preconnect });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("xiaomi oauth validation", () => {
	it("validates standard API keys with Bearer authorization", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			fetchImplementation(async (_input, init) => {
				const headers = new Headers(init?.headers);
				return headers.get("Authorization") === "Bearer sk-valid" && !headers.has("x-api-key")
					? new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
					: new Response("Invalid API Key", { status: 401 });
			}),
		);

		await loginXiaomi({
			onPrompt: async () => "sk-valid",
			onAuth: () => {},
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses a fresh AbortSignal per endpoint so SGP timeout doesn't abort AMS fallback", async () => {
		const capturedSignals: (AbortSignal | undefined)[] = [];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			fetchImplementation(async (_input, init) => {
				capturedSignals.push(init?.signal ?? undefined);
				if (capturedSignals.length === 1) {
					// Simulate SGP timing out: throw an AbortError as AbortSignal.timeout would.
					throw new DOMException("The operation was aborted due to timeout.", "AbortError");
				}
				return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
			}),
		);

		await loginXiaomi({
			onPrompt: async () => "tp-test-key",
			onAuth: () => {},
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);
		expect(capturedSignals[1]).toBeInstanceOf(AbortSignal);
		// Two distinct signals — proves a fresh timeout was created for AMS.
		expect(capturedSignals[0]).not.toBe(capturedSignals[1]);
		// And the AMS signal is not aborted (would be if the timeout signal were shared).
		expect(capturedSignals[1]?.aborted).toBe(false);
	});
});
