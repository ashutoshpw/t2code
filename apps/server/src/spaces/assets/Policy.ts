export const fileLimits = Object.freeze({
  image: 10 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  imagePixels: 24_000_000,
  headerBytes: 64 * 1024,
});

export type MediaKind = "image" | "pdf" | "video";

export const mediaTypes = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "pdf",
  "video/mp4": "video",
  "video/webm": "video",
} as const satisfies Record<string, MediaKind>;

export type MediaType = keyof typeof mediaTypes;

export const assetLimits = Object.freeze({
  maxImageBytes: fileLimits.image,
  maxPdfBytes: fileLimits.pdf,
  maxVideoBytes: fileLimits.video,
  maxImagePixels: fileLimits.imagePixels,
  maxHeaderBytes: fileLimits.headerBytes,
  maxEnvironmentBytes: 2 * 1024 ** 3,
  maxPendingPerCaller: 2,
  maxPendingUploads: 16,
  maxActiveUploads: 4,
  uploadTtlMs: 10 * 60_000,
  recoveryBatchRows: 100,
  recoveryBatchBytes: 256 * 1024 ** 2,
});
