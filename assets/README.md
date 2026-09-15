# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `text.svg` for the T2 wordmark and `background.svg` when the background is a vector layer. Additional layers use semantic names that describe their role and placement.

On macOS, run `vp run icons:export` from the repository root to regenerate the tracked iOS,
Linux, Windows, and web assets with Icon Composer. The development web exports are also copied to
`apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that
the native-generated assets and public copies match their sources without changing files.

## Portable exports

Icon Composer is macOS-only. `vp run icons:export:portable` is the cross-platform
fallback used by Linux and CI: it renders the same checked-in SVG layers and canonical T2 path
with Sharp, then writes the iOS/universal PNGs, safe-area macOS PNGs, web sizes, ICO files,
marketing icons, and the `/95` concept artwork. The portable macOS output keeps the classic
824px body inset in a transparent 1024px canvas but does not include Icon Composer's native
shadow treatment.

Run `vp run icons:check:portable` to verify every portable output without changing files. The
portable export command also regenerates the development copies under `apps/web/public` and the
static marketing favicons. Native and portable exports intentionally differ in Icon Composer's
native shadow treatment; use the matching check command for the export path you selected. Keep the
legacy `t3-black-*` filenames until their consumers are deliberately migrated.

The vector layers are deterministic, but the `/95` concept labels use the host's
`Arial, Helvetica, sans-serif` fallback. Their bytes can therefore differ between machines with
different installed fonts; run the portable check in the same font environment used for export.

The marketing `apps/marketing/src/assets/app-desktop.webp` file is a captured product screenshot,
not a standalone brand asset. It is intentionally outside this generator and needs a fresh product
capture before its embedded UI branding can be updated.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

Icon Composer's command-line exporter does not expose the `macOS pre-Tahoe` preset. A plain command-line `macOS` export is full bleed and is not suitable for the desktop app, so the export script intentionally leaves the tracked macOS PNGs unchanged and prints a reminder after every run.

After changing an Icon Composer project, open it in Icon Composer and export the macOS PNG with exactly these settings:

- Platform: `macOS pre-Tahoe`
- Appearance: `Default`
- Size: `1024pt`
- Scale: `1×`

Save the three exports to:

- `dev/app-icon.icon` -> `dev/blueprint-macos-1024.png`
- `nightly/app-icon.icon` -> `nightly/nightly-macos-1024.png`
- `prod/app-icon.icon` -> `prod/black-macos-1024.png`

The result must be a 1024×1024 PNG with the classic macOS safe area: the opaque icon body is 824×824, inset 100 pixels on every side, with only the native Icon Composer shadow extending into the surrounding transparent canvas.

To have Codex perform the native exports, paste this prompt into a task opened at the repository root:

```text
Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.

For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:

- assets/dev/app-icon.icon -> assets/dev/blueprint-macos-1024.png
- assets/nightly/app-icon.icon -> assets/nightly/nightly-macos-1024.png
- assets/prod/app-icon.icon -> assets/prod/black-macos-1024.png

Do not resize, composite, or otherwise post-process the exported PNGs.

Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.
```

Do not edit the generated PNG or ICO files directly.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the wordmark is cropped. The Android artwork
is instead rendered from the same Icon Composer SVG sources by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent wordmark, sized to stay
  inside the safe zone
- `apps/mobile/assets/android-icon-mark.png` and `android-notification-icon.png`: transparent
  white wordmarks for Android's monochrome and notification resources
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: full-bleed variant
  artwork (blueprint grid and annotations; night sky and clouds). Production uses a solid color.
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.

Rerun the export after changing a layer SVG or the canonical wordmark. The Android wordmark
resources are generated from the production `text.svg`; the launcher and splash variants retain
their channel-specific backgrounds.
