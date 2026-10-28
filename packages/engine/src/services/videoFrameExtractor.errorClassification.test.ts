import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeDownloadUrlIdentity, UrlDownloadError } from "../utils/urlDownloader.js";
import {
  classifyFfmpegSpawnError,
  classifyVideoExtractionError,
  extractAllVideoFrames,
} from "./videoFrameExtractor.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function extractionOutputDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-extraction-failure-"));
  tempDirs.push(dir);
  return dir;
}

function remoteVideo(source: string, id = "hero-video") {
  return {
    id,
    src: source,
    start: 0,
    end: 0.1,
    mediaStart: 0,
    playbackRate: 1,
    loop: false,
    hasAudio: false,
  };
}

describe("classifyFfmpegSpawnError", () => {
  it.each(["ENOENT", "EACCES", "ENOEXEC", "UNKNOWN"])(
    "keeps deterministic launch failure %s terminal",
    (code) => {
      expect(classifyFfmpegSpawnError(Object.assign(new Error(code), { code }))).toMatchObject({
        retryable: false,
      });
    },
  );

  it.each(["EAGAIN", "EMFILE", "ENFILE"])("retries known transient launch failure %s", (code) => {
    expect(classifyFfmpegSpawnError(Object.assign(new Error(code), { code }))).toMatchObject({
      kind: "ffmpeg_transient",
      retryable: true,
    });
  });
});

describe("classifyVideoExtractionError download integrity", () => {
  it("keeps deterministic HTML payloads non-retryable and user-owned as invalid media", () => {
    const classified = classifyVideoExtractionError(
      new UrlDownloadError("invalid_payload", false, "HTML payload"),
    );
    expect(classified).toMatchObject({ kind: "invalid_media", retryable: false });
  });

  it.each(["range_protocol", "length_mismatch", "hash_mismatch"] as const)(
    "keeps %s retryable after the downloader's one clean refetch is exhausted",
    (kind) => {
      expect(
        classifyVideoExtractionError(new UrlDownloadError(kind, true, "integrity failure")),
      ).toMatchObject({ kind: "download_transient", retryable: true });
    },
  );
});

describe("extractAllVideoFrames download failure metadata", () => {
  it("threads a query-free fingerprint, allowlisted host, and zero used retries", async () => {
    const source =
      "https://media.customer-cdn.example/private/clip.mp4?X-Amz-Signature=super-secret#fragment";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<!doctype html><html><body>denied</body></html>")),
    );

    const result = await extractAllVideoFrames(
      [
        {
          id: "private-video-id",
          src: source,
          start: 0,
          end: 1,
          mediaStart: 0,
          playbackRate: 1,
          loop: false,
          hasAudio: false,
        },
      ],
      extractionOutputDir(),
      { fps: 30, outputDir: extractionOutputDir() },
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.group).toEqual({
      sourceFingerprint: `sha256:${safeDownloadUrlIdentity(source).urlFingerprint}`,
      host: "media.customer-cdn.example",
      status: 200,
      statusClass: "other",
      retry: { phase: "download", used: 0, budget: 1 },
    });
    expect(JSON.stringify(result.errors[0]?.group)).not.toContain("super-secret");
    expect(JSON.stringify(result.errors[0]?.group)).not.toContain("private-video-id");
  });

  it("collapses an exhausted HTTP retry to status class and normalized host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractAllVideoFrames(
      [
        {
          id: "v1",
          src: "https://customer-cdn.example/clip.mp4?token=secret",
          start: 0,
          end: 1,
          mediaStart: 0,
          playbackRate: 1,
          loop: false,
          hasAudio: false,
        },
      ],
      extractionOutputDir(),
      { fps: 30, outputDir: extractionOutputDir() },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.errors[0]).toMatchObject({
      kind: "download_transient",
      retryable: true,
      group: {
        host: "customer-cdn.example",
        statusClass: "http_5xx",
        retry: { phase: "download", used: 1, budget: 1 },
      },
    });
  });

  it.each([
    [403, "source_rejected", false],
    [404, "download_not_found", false],
  ] as const)(
    "preserves HTTP %i in the terminal acquisition diagnostic",
    async (status, kind, retryable) => {
      const source =
        "https://media.customer-cdn.example/private/clip.mp4?X-Amz-Signature=must-not-leak";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));

      const result = await extractAllVideoFrames([remoteVideo(source)], extractionOutputDir(), {
        fps: 30,
        outputDir: extractionOutputDir(),
      });

      expect(result.errors[0]).toMatchObject({
        videoId: "hero-video",
        kind,
        retryable,
        group: {
          status,
          statusClass: "http_4xx",
        },
      });
      expect(JSON.stringify(result.errors[0]?.group)).not.toContain("must-not-leak");
    },
  );

  it("preserves a typed timeout as retryable terminal acquisition context", async () => {
    const source =
      "https://media.customer-cdn.example/private/clip.mp4?X-Amz-Signature=must-not-leak";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new UrlDownloadError("timeout", true, "Download timed out")),
    );

    const result = await extractAllVideoFrames([remoteVideo(source)], extractionOutputDir(), {
      fps: 30,
      outputDir: extractionOutputDir(),
    });

    expect(result.errors[0]).toMatchObject({
      videoId: "hero-video",
      kind: "download_transient",
      retryable: true,
      group: {
        statusClass: "timeout",
        retry: { phase: "download", used: 1, budget: 1 },
      },
    });
    expect(JSON.stringify(result.errors[0]?.group)).not.toContain("must-not-leak");
  });

  it("identifies a missing local source without inventing download metadata", async () => {
    const result = await extractAllVideoFrames(
      [remoteVideo("assets/does-not-exist.mp4")],
      extractionOutputDir(),
      { fps: 30, outputDir: extractionOutputDir() },
    );

    expect(result.errors[0]).toMatchObject({
      videoId: "hero-video",
      kind: "source_missing",
      retryable: false,
    });
    expect(result.errors[0]?.group).toBeUndefined();
  });

  it("does not create an acquisition diagnostic for a successful remote source", async () => {
    const source =
      "https://media.customer-cdn.example/private/clip.mp4?X-Amz-Signature=must-not-leak";
    const fixture = readFileSync(
      join(
        import.meta.dirname,
        "../../../studio/tests/e2e/fixtures/design-panel-qa/assets/test.mp4",
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(fixture, {
          status: 200,
          headers: {
            "content-length": String(fixture.length),
            "content-type": "video/mp4",
          },
        }),
      ),
    );

    const result = await extractAllVideoFrames([remoteVideo(source)], extractionOutputDir(), {
      fps: 30,
      outputDir: extractionOutputDir(),
    });

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
