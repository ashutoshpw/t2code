# Media assets

## Serving through the existing asset route

Serve Spaces media from the existing signed `/api/assets/<token>/<name>` route ([AssetAccess](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/server/src/assets/AssetAccess.ts)). Do not add a new route, cookie, or header scheme.

- Signed asset URLs are bearer credentials. Read access is checked when a URL is minted, not on each request ([environment auth](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/docs/internals/environment-auth.md)). This is what lets `<img>`, `<video>`, the Electron custom scheme, expo-video, and the native PDF viewers work over local, remote, and tunnel connections without auth headers. Keep it.
- Add a `spaces-asset` variant to `AssetResource` and to the asset claims. Ship the variant in contracts, the server's `resolveAsset`, and the web/mobile clients together.
- At serve time, the resolver checks that Spaces is enabled, that the asset exists in a ready state, and that it is not collected. This gives revocation through disable or delete without checking the session.
- Mint URLs only after authorization through RPC. Use the existing TTL or a shorter one. Blocks store asset IDs, and clients mint fresh URLs when rendering and again after reconnect or a route change. A player re-mints a URL when it expires and keeps its playback position.

## Range and caching

The current range support covers only `audio/*` and `video/*`. Any `If-Range` header falls back to a full `200`, and host media omits validators on purpose because host files can change in place.

Spaces assets are immutable and content-addressed, so the Spaces resolver can do better:

- Return a strong `ETag` (the content digest) and `Cache-Control: private, immutable`.
- Support `HEAD`, a single-range `206`, `416`, and `If-Range` against the strong ETag for video **and PDF**. Images can stay full-body.
- Confirm that the global compression middleware skips media and PDF content types so `Content-Length` and ranges hold.
- Verify `206` pass-through on remote and T2 Connect tunnel paths.

## Uploads

Reuse the staged attachment upload pattern: an RPC mints an upload token, then the client sends an HTTP POST with a checked `Content-Length`.

- Stream to a `.part` file in the Spaces staging directory and hash incrementally. Never buffer a whole file in memory.
- Publish in three steps: verified staged bytes, then an immutable file at `<userdata>/spaces/assets/<digest>`, then the metadata row marked `ready`. Finalize and retry are idempotent.
- Filesystem and SQLite changes do not commit together, so reconcile incomplete states at startup.
- Validate the MIME type from content. Enforce the per-type caps and the environment quota from [decisions.md](decisions.md). Bound concurrent uploads per client.
- v1 has no resumable uploads. Failed uploads restart, so the video cap must be sized to keep restarts acceptable on mobile.

Preserve originals. Mobile already has native preview paths: QuickLook on iOS, `react-native-pdf-jsi` on Android, a WebView PDF, and expo-video. Choose one PDF path per platform during feasibility. Always offer download as a fallback.

## Reference-aware cleanup

The same blob can be referenced by several blocks, revisions, and trashed pages.

- Serialize reference creation against deletion eligibility in the Spaces transaction.
- Collect a blob only after a grace period, and only when no live block, retained revision, trashed page, or pending upload references it. Recheck and tombstone it before deleting bytes.
- The startup sweep removes `.part` files and pending uploads that are older than their expiry.
- Include Spaces staging and asset bytes in storage reporting and `doctor`.
