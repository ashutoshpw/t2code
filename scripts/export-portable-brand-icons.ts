#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - portable asset CLI uses Node file IO and reports check results directly.

// Cross-platform brand export for environments without Icon Composer.
//
// Icon Composer remains the native source for macOS pre-Tahoe styling. This renderer
// intentionally uses the checked-in SVG layers and the shared T2 path so CI, Linux,
// and contributors can regenerate the tracked raster family, including a safe-area
// macOS fallback without Icon Composer's native shadow treatment.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { T2_WORDMARK_ASPECT_RATIO, T2_WORDMARK_PATH } from "@t2code/shared/t2Wordmark";
import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

type Brand = "development" | "nightly" | "production";
type Concept = "lime" | "clouds" | "chrome" | "desktop" | "foil" | "lavender";
export type IconShape = "rounded" | "square";

interface IconOutputs {
  readonly ios: string;
  readonly macos: string;
  readonly universal: string;
  readonly appleTouch: string;
  readonly favicon16: string;
  readonly favicon32: string;
  readonly faviconIco: string;
  readonly windowsIco: string;
}

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const ICON_SIZE = 1024;
const MACOS_BODY_SIZE = 824;
const MACOS_INSET = 100;
const COMPOSER_CANVAS = 1024;
const COMPOSER_LAYER_SCALE = 8.5;
const WORDMARK_FRACTION = 0.785;
const SVG_DENSITY = 300;
const MARKETING_ICON_SIZE = 1024;
const CONCEPT_WIDTH = 960;
const CONCEPT_HEIGHT = 1200;
const PNG_OPTIONS = { compressionLevel: 9, adaptiveFiltering: false } as const;
const WEBP_OPTIONS = { lossless: true, effort: 6 } as const;

const ICON_VARIANTS: ReadonlyArray<{ readonly brand: Brand; readonly outputs: IconOutputs }> = [
  {
    brand: "development",
    outputs: {
      ios: "assets/dev/blueprint-ios-1024.png",
      macos: "assets/dev/blueprint-macos-1024.png",
      universal: "assets/dev/blueprint-universal-1024.png",
      appleTouch: "assets/dev/blueprint-web-apple-touch-180.png",
      favicon16: "assets/dev/blueprint-web-favicon-16x16.png",
      favicon32: "assets/dev/blueprint-web-favicon-32x32.png",
      faviconIco: "assets/dev/blueprint-web-favicon.ico",
      windowsIco: "assets/dev/blueprint-windows.ico",
    },
  },
  {
    brand: "nightly",
    outputs: {
      ios: "assets/nightly/nightly-ios-1024.png",
      macos: "assets/nightly/nightly-macos-1024.png",
      universal: "assets/nightly/nightly-universal-1024.png",
      appleTouch: "assets/nightly/nightly-web-apple-touch-180.png",
      favicon16: "assets/nightly/nightly-web-favicon-16x16.png",
      favicon32: "assets/nightly/nightly-web-favicon-32x32.png",
      faviconIco: "assets/nightly/nightly-web-favicon.ico",
      windowsIco: "assets/nightly/nightly-windows.ico",
    },
  },
  {
    brand: "production",
    outputs: {
      ios: "assets/prod/black-ios-1024.png",
      macos: "assets/prod/black-macos-1024.png",
      universal: "assets/prod/black-universal-1024.png",
      appleTouch: "assets/prod/t2-black-web-apple-touch-180.png",
      favicon16: "assets/prod/t2-black-web-favicon-16x16.png",
      favicon32: "assets/prod/t2-black-web-favicon-32x32.png",
      faviconIco: "assets/prod/t2-black-web-favicon.ico",
      windowsIco: "assets/prod/t2-black-windows.ico",
    },
  },
];

const CONCEPT_OUTPUTS: ReadonlyArray<{
  readonly concept: Concept;
  readonly stem: string;
  readonly sizes: ReadonlyArray<320 | 640 | 960>;
}> = [
  { concept: "lime", stem: "t3-code-lime", sizes: [320, 640, 960] },
  { concept: "clouds", stem: "t3-code-nightly-clouds", sizes: [320, 640, 960] },
  { concept: "chrome", stem: "t3-code-chrome", sizes: [960] },
  { concept: "desktop", stem: "t3-code-desktop", sizes: [960] },
  { concept: "foil", stem: "t3-code-nightly-foil", sizes: [320, 640, 960] },
  { concept: "lavender", stem: "t3-code-nightly-lavender", sizes: [320, 640, 960] },
];

const sourceDirectory = (brand: Brand): string =>
  brand === "development" ? "dev" : brand === "nightly" ? "nightly" : "prod";

const sourcePath = (brand: Brand, filename: string): string =>
  NodePath.join(ROOT, "assets", sourceDirectory(brand), "app-icon.icon", "Assets", filename);

const readSource = (brand: Brand, filename: string): Promise<string> =>
  NodeFSP.readFile(sourcePath(brand, filename), "utf8");

const removeRoundedClip = (source: string): string => {
  const clipAttribute = ' clip-path="url(#frame)"';
  if (!source.includes(clipAttribute)) {
    throw new Error("Portable icon source is missing its expected rounded frame clip.");
  }
  return source.replace(clipAttribute, "");
};

const formatNumber = (value: number): string => value.toFixed(4).replace(/\.0+$/, "");

const canvasSvg = (width: number, height: number, inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">${inner}</svg>`;

const composerTransform = (size: number): string => {
  const scale = (size / COMPOSER_CANVAS) * COMPOSER_LAYER_SCALE;
  const translation = (size - 128 * scale) / 2;
  return `translate(${formatNumber(translation)} ${formatNumber(translation)}) scale(${formatNumber(scale)})`;
};

const wordmarkMarkup = (
  targetWidth: number,
  centerX: number,
  centerY: number,
  fill: string,
  options: { readonly opacity?: number; readonly offsetX?: number; readonly offsetY?: number } = {},
): string => {
  const scale = targetWidth / 94.3941;
  const targetHeight = targetWidth / T2_WORDMARK_ASPECT_RATIO;
  const x = centerX + (options.offsetX ?? 0) - targetWidth / 2 - 15.5309 * scale;
  const y = centerY + (options.offsetY ?? 0) - targetHeight / 2 - 37 * scale;
  const opacity =
    options.opacity === undefined ? "" : ` opacity="${formatNumber(options.opacity)}"`;
  return `<g transform="translate(${formatNumber(x)} ${formatNumber(y)}) scale(${formatNumber(scale)})"><path d="${T2_WORDMARK_PATH}" fill="${fill}"${opacity}/></g>`;
};

const wordmarkSvg = (
  width: number,
  height: number,
  targetWidth: number,
  centerX: number,
  centerY: number,
  fill: string,
): string => canvasSvg(width, height, wordmarkMarkup(targetWidth, centerX, centerY, fill));

const rasterizeSvg = async (svg: string, width: number, height = width): Promise<Buffer> =>
  sharp(Buffer.from(svg), { density: SVG_DENSITY })
    .resize({ width, height, fit: "fill" })
    .png(PNG_OPTIONS)
    .toBuffer();

const rasterizeWebp = async (svg: string, width: number, height: number): Promise<Buffer> =>
  sharp(Buffer.from(svg), { density: SVG_DENSITY })
    .resize({ width, height, fit: "fill" })
    .webp(WEBP_OPTIONS)
    .toBuffer();

const compose = async (
  base: Buffer,
  overlays: ReadonlyArray<{
    readonly input: Buffer;
    readonly left?: number;
    readonly top?: number;
  }>,
): Promise<Buffer> =>
  sharp(base)
    .composite([...overlays])
    .png(PNG_OPTIONS)
    .toBuffer();

const roundedMask = async (size: number): Promise<Buffer> =>
  rasterizeSvg(
    canvasSvg(
      size,
      size,
      `<rect width="${size}" height="${size}" rx="${formatNumber((size * 10) / 128)}" fill="white"/>`,
    ),
    size,
  );

const clipToRoundedBody = async (image: Buffer, size: number): Promise<Buffer> => {
  const mask = await roundedMask(size);
  return sharp(image)
    .composite([{ input: mask, blend: "dest-in" }])
    .png(PNG_OPTIONS)
    .toBuffer();
};

const renderCloudOverlays = async (
  size: number,
): Promise<
  ReadonlyArray<{ readonly input: Buffer; readonly left: number; readonly top: number }>
> => {
  const clouds = [
    { file: "cloud-lower-left.svg", scale: 25, translation: [-309.6375, 268.66077693836917] },
    {
      file: "cloud-upper-right.svg",
      scale: 15,
      translation: [387.9605131881942, -134.30064713259117],
    },
  ] as const;
  const scaleToCanvas = size / COMPOSER_CANVAS;
  const overlays: Array<{ readonly input: Buffer; readonly left: number; readonly top: number }> =
    [];

  for (const cloud of clouds) {
    const width = Math.round(64 * cloud.scale * scaleToCanvas);
    const height = Math.round(32 * cloud.scale * scaleToCanvas);
    const left = Math.round(
      (COMPOSER_CANVAS / 2 + cloud.translation[0]) * scaleToCanvas - width / 2,
    );
    const top = Math.round(
      (COMPOSER_CANVAS / 2 + cloud.translation[1]) * scaleToCanvas - height / 2,
    );
    const source = (await readSource("nightly", cloud.file)).replace(/ filter="url\(#soft\)"/g, "");
    const raster = await rasterizeSvg(source, width, height);
    const x0 = Math.max(0, left);
    const y0 = Math.max(0, top);
    const x1 = Math.min(size, left + width);
    const y1 = Math.min(size, top + height);
    if (x1 <= x0 || y1 <= y0) continue;
    const clipped = await sharp(raster)
      .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
      .png(PNG_OPTIONS)
      .toBuffer();
    overlays.push({ input: clipped, left: x0, top: y0 });
  }
  return overlays;
};

const renderDevelopmentAnnotations = async (size: number): Promise<Buffer> => {
  const source = await readSource("development", "annotations.svg");
  const defs = source.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? "";
  const body = source.replace(/^[\s\S]*?<\/defs>/, "").replace(/<\/svg>\s*$/, "");
  return rasterizeSvg(
    canvasSvg(size, size, `${defs}<g transform="${composerTransform(size)}">${body}</g>`),
    size,
  );
};

const renderIconBody = async (brand: Brand, size: number, shape: IconShape): Promise<Buffer> => {
  let base: Buffer;
  if (brand === "production") {
    base = await rasterizeSvg(
      canvasSvg(
        size,
        size,
        `<rect width="${size}" height="${size}"${shape === "rounded" ? ` rx="${formatNumber((size * 10) / 128)}"` : ""} fill="#000"/>`,
      ),
      size,
    );
  } else {
    const source = await readSource(brand, "background.svg");
    base = await rasterizeSvg(shape === "square" ? removeRoundedClip(source) : source, size);
  }

  const overlays: Array<{ readonly input: Buffer; readonly left?: number; readonly top?: number }> =
    [];
  if (brand === "nightly") {
    overlays.push(...(await renderCloudOverlays(size)));
  }
  if (brand === "development") {
    overlays.push({ input: await renderDevelopmentAnnotations(size) });
  }
  let image = await compose(base, overlays);
  if (shape === "rounded") image = await clipToRoundedBody(image, size);

  const mark = await rasterizeSvg(
    wordmarkSvg(size, size, size * WORDMARK_FRACTION, size / 2, size / 2, "white"),
    size,
  );
  const composed = await compose(image, [{ input: mark }]);
  return shape === "square" ? sharp(composed).removeAlpha().png(PNG_OPTIONS).toBuffer() : composed;
};

export const renderIcon = async (
  brand: Brand,
  size: number,
  options: { readonly macos?: boolean; readonly shape?: IconShape } = {},
): Promise<Buffer> => {
  if (!options.macos) return renderIconBody(brand, size, options.shape ?? "rounded");
  const body = await renderIconBody(brand, MACOS_BODY_SIZE, "rounded");
  const canvas = await sharp({
    create: {
      width: ICON_SIZE,
      height: ICON_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: body, left: MACOS_INSET, top: MACOS_INSET }])
    .png(PNG_OPTIONS)
    .toBuffer();
  return canvas;
};

const pngToWebp = (png: Buffer): Promise<Buffer> => sharp(png).webp(WEBP_OPTIONS).toBuffer();

const addAsset = (assets: Map<string, Buffer>, path: string, contents: Buffer): void => {
  const previous = assets.get(path);
  if (previous && !previous.equals(contents)) {
    throw new Error(`Portable export assigned different contents to ${path}.`);
  }
  assets.set(path, contents);
};

const renderIconFamily = async (assets: Map<string, Buffer>): Promise<void> => {
  for (const variant of ICON_VARIANTS) {
    const ios = await renderIcon(variant.brand, ICON_SIZE, { shape: "square" });
    const universal = await renderIcon(variant.brand, ICON_SIZE);
    const macos = await renderIcon(variant.brand, ICON_SIZE, { macos: true });
    const appleTouch = await renderIcon(variant.brand, 180);
    const favicon16 = await renderIcon(variant.brand, 16);
    const favicon32 = await renderIcon(variant.brand, 32);
    const icoImages = await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({
        size,
        contents: await renderIcon(variant.brand, size),
      })),
    );
    const ico = encodePngIco(icoImages);

    addAsset(assets, variant.outputs.ios, ios);
    addAsset(assets, variant.outputs.universal, universal);
    addAsset(assets, variant.outputs.macos, macos);
    addAsset(assets, variant.outputs.appleTouch, appleTouch);
    addAsset(assets, variant.outputs.favicon16, favicon16);
    addAsset(assets, variant.outputs.favicon32, favicon32);
    addAsset(assets, variant.outputs.faviconIco, ico);
    addAsset(assets, variant.outputs.windowsIco, ico);
  }

  const development = ICON_VARIANTS[0]?.outputs;
  if (!development) throw new Error("Portable icon variants are empty.");
  const developmentPublicCopies: ReadonlyArray<[string, string]> = [
    [development.faviconIco, "apps/web/public/favicon.ico"],
    [development.favicon16, "apps/web/public/favicon-16x16.png"],
    [development.favicon32, "apps/web/public/favicon-32x32.png"],
    [development.appleTouch, "apps/web/public/apple-touch-icon.png"],
  ];
  for (const [source, target] of developmentPublicCopies) {
    const contents = assets.get(source);
    if (!contents) throw new Error(`Portable development icon is missing: ${source}`);
    addAsset(assets, target, contents);
  }
};

const label = (
  value: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  options: { readonly anchor?: string; readonly weight?: number; readonly spacing?: number } = {},
): string =>
  `<text x="${formatNumber(x)}" y="${formatNumber(y)}" fill="${fill}" font-family="Arial, Helvetica, sans-serif" font-size="${formatNumber(size)}" font-weight="${options.weight ?? 600}" letter-spacing="${formatNumber(options.spacing ?? 0)}" text-anchor="${options.anchor ?? "start"}">${value}</text>`;

const scaled = (value: number, width: number): number => (value * width) / CONCEPT_WIDTH;

const conceptCloud = (
  x: number,
  y: number,
  scale: number,
  fill: string,
  opacity: number,
  width: number,
): string =>
  `<g transform="translate(${formatNumber(scaled(x, width))} ${formatNumber(scaled(y, width))}) scale(${formatNumber((width / CONCEPT_WIDTH) * scale)})" opacity="${formatNumber(opacity)}"><path d="M0 80C12 55 34 50 58 59C65 30 88 12 119 18C141 -6 181 4 191 37C218 21 252 34 258 67C278 66 295 76 304 95H0Z" fill="${fill}"/></g>`;

const conceptWindow = (
  x: number,
  y: number,
  width: number,
  height: number,
  bar: string,
  code: string,
  scale: number,
): string => {
  const sx = width * scale;
  const sy = height * scale;
  const left = x * scale;
  const top = y * scale;
  return `<g transform="translate(${formatNumber(left)} ${formatNumber(top)})"><rect width="${formatNumber(sx)}" height="${formatNumber(sy)}" rx="${formatNumber(8 * scale)}" fill="#DCE1E7" stroke="#101D36" stroke-width="${formatNumber(4 * scale)}"/><rect x="${formatNumber(8 * scale)}" y="${formatNumber(8 * scale)}" width="${formatNumber(sx - 16 * scale)}" height="${formatNumber(25 * scale)}" fill="${bar}"/><circle cx="${formatNumber(sx - 29 * scale)}" cy="${formatNumber(20 * scale)}" r="${formatNumber(4 * scale)}" fill="#101D36"/><circle cx="${formatNumber(sx - 16 * scale)}" cy="${formatNumber(20 * scale)}" r="${formatNumber(4 * scale)}" fill="#101D36"/><rect x="${formatNumber(14 * scale)}" y="${formatNumber(50 * scale)}" width="${formatNumber(sx * 0.72)}" height="${formatNumber(6 * scale)}" rx="${formatNumber(3 * scale)}" fill="${code}"/><rect x="${formatNumber(14 * scale)}" y="${formatNumber(68 * scale)}" width="${formatNumber(sx * 0.54)}" height="${formatNumber(6 * scale)}" rx="${formatNumber(3 * scale)}" fill="${code}" opacity=".78"/><rect x="${formatNumber(14 * scale)}" y="${formatNumber(86 * scale)}" width="${formatNumber(sx * 0.63)}" height="${formatNumber(6 * scale)}" rx="${formatNumber(3 * scale)}" fill="${code}" opacity=".6"/><rect x="${formatNumber(14 * scale)}" y="${formatNumber(104 * scale)}" width="${formatNumber(sx * 0.38)}" height="${formatNumber(6 * scale)}" rx="${formatNumber(3 * scale)}" fill="${code}" opacity=".48"/></g>`;
};

const conceptSvg = (concept: Concept, width: number, height: number): string => {
  const scale = width / CONCEPT_WIDTH;
  const centerX = width / 2;
  const commonDefs = `<filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="${formatNumber(scaled(12, width))}"/><feOffset dy="${formatNumber(scaled(10, width))}"/><feComponentTransfer><feFuncA type="linear" slope=".35"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

  switch (concept) {
    case "lime":
      return canvasSvg(
        width,
        height,
        `<defs>${commonDefs}<linearGradient id="limePanel" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#E0FF62"/><stop offset="1" stop-color="#B4DD2D"/></linearGradient><linearGradient id="tealPanel" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0E7680"/><stop offset="1" stop-color="#063E4A"/></linearGradient><pattern id="limeGrid" width="${formatNumber(scaled(48, width))}" height="${formatNumber(scaled(48, width))}" patternUnits="userSpaceOnUse"><path d="M ${formatNumber(scaled(48, width))} 0H0V${formatNumber(scaled(48, width))}" fill="none" stroke="#A8E3CF" stroke-opacity=".28" stroke-width="${formatNumber(scaled(2, width))}"/></pattern></defs><rect width="${width}" height="${height}" fill="#071115"/><rect x="${formatNumber(scaled(48, width))}" y="${formatNumber(scaled(48, width))}" width="${formatNumber(scaled(864, width))}" height="${formatNumber(scaled(468, width))}" rx="${formatNumber(scaled(12, width))}" fill="url(#limePanel)"/><rect x="${formatNumber(scaled(48, width))}" y="${formatNumber(scaled(516, width))}" width="${formatNumber(scaled(864, width))}" height="${formatNumber(scaled(636, width))}" rx="${formatNumber(scaled(12, width))}" fill="url(#tealPanel)"/><rect x="${formatNumber(scaled(48, width))}" y="${formatNumber(scaled(516, width))}" width="${formatNumber(scaled(864, width))}" height="${formatNumber(scaled(636, width))}" rx="${formatNumber(scaled(12, width))}" fill="url(#limeGrid)"/><g filter="url(#softShadow)">${wordmarkMarkup(scaled(650, width), centerX, scaled(295, width), "#071115")}</g>${label("AGENT CONTROL CENTER", scaled(84, width), scaled(585, width), scaled(28, width), "#E0FF62", { spacing: scaled(4, width) })}${label("SOURCE INCLUDED", scaled(84, width), scaled(1066, width), scaled(24, width), "#D7FAF2", { spacing: scaled(5, width) })}<circle cx="${formatNumber(scaled(756, width))}" cy="${formatNumber(scaled(884, width))}" r="${formatNumber(scaled(88, width))}" fill="none" stroke="#B7F05B" stroke-width="${formatNumber(scaled(4, width))}" opacity=".72"/><path d="M${formatNumber(scaled(704, width))} ${formatNumber(scaled(884, width))}H${formatNumber(scaled(808, width))}M${formatNumber(scaled(756, width))} ${formatNumber(scaled(832, width))}V${formatNumber(scaled(936, width))}" stroke="#B7F05B" stroke-width="${formatNumber(scaled(4, width))}" opacity=".72"/>`,
      );
    case "clouds":
      return canvasSvg(
        width,
        height,
        `<defs>${commonDefs}<linearGradient id="nightPoster" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#060F2A"/><stop offset=".52" stop-color="#151644"/><stop offset="1" stop-color="#3D1766"/></linearGradient><linearGradient id="cloudOne" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#4B9DFF"/><stop offset="1" stop-color="#7B3CE0"/></linearGradient><linearGradient id="cloudTwo" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#4C6DDB"/><stop offset="1" stop-color="#B65AE9"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#nightPoster)"/>${[
          [130, 200, 5, "#E5EAFF", 0.68],
          [760, 260, 3, "#AEBFFF", 0.54],
          [240, 512, 4, "#EEF2FF", 0.5],
          [690, 604, 5, "#D7DFFF", 0.46],
        ]
          .map(
            ([x, y, r, c, o]) =>
              `<circle cx="${formatNumber(scaled(Number(x), width))}" cy="${formatNumber(scaled(Number(y), width))}" r="${formatNumber(scaled(Number(r), width))}" fill="${String(c)}" opacity="${String(o)}"/>`,
          )
          .join(
            "",
          )}${wordmarkMarkup(scaled(650, width), centerX, scaled(295, width), "white", { offsetY: 6, opacity: 0.25 })}${wordmarkMarkup(scaled(650, width), centerX, scaled(295, width), "white")}${label("NIGHTLY", centerX, scaled(540, width), scaled(30, width), "#C29BFF", { anchor: "middle", spacing: scaled(8, width) })}${conceptCloud(-40, 860, 1.25, "url(#cloudOne)", 0.75, width)}${conceptCloud(600, 810, 1.1, "url(#cloudTwo)", 0.8, width)}${conceptCloud(180, 970, 1.4, "#5739B3", 0.7, width)}${label("SOURCE INCLUDED", centerX, scaled(1100, width), scaled(24, width), "#D7DFFF", { anchor: "middle", spacing: scaled(5, width) })}`,
      );
    case "chrome":
      return canvasSvg(
        width,
        height,
        `<defs>${commonDefs}<linearGradient id="chromeMark" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#FFFFFF"/><stop offset=".3" stop-color="#9DA7B7"/><stop offset=".52" stop-color="#FFFFFF"/><stop offset=".78" stop-color="#69788E"/><stop offset="1" stop-color="#F1F5FA"/></linearGradient><linearGradient id="chromeBase" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#050608"/><stop offset=".6" stop-color="#111522"/><stop offset="1" stop-color="#020304"/></linearGradient><pattern id="chromeGrid" width="${formatNumber(scaled(80, width))}" height="${formatNumber(scaled(80, width))}" patternUnits="userSpaceOnUse"><path d="M0 0H${formatNumber(scaled(80, width))}V${formatNumber(scaled(80, width))}" fill="none" stroke="#B9F33A" stroke-opacity=".45" stroke-width="${formatNumber(scaled(2, width))}"/></pattern></defs><rect width="${width}" height="${height}" fill="url(#chromeBase)"/><path d="M0 ${formatNumber(scaled(980, width))}L${width} ${formatNumber(scaled(780, width))}V${height}H0Z" fill="url(#chromeGrid)" opacity=".72"/><g filter="url(#softShadow)">${wordmarkMarkup(scaled(650, width), centerX, scaled(330, width), "url(#chromeMark)")}</g><rect x="${formatNumber(scaled(170, width))}" y="${formatNumber(scaled(550, width))}" width="${formatNumber(scaled(620, width))}" height="${formatNumber(scaled(58, width))}" fill="#B9F33A"/>${label("AGENT CONTROL CENTER", centerX, scaled(591, width), scaled(25, width), "#050608", { anchor: "middle", weight: 800, spacing: scaled(2, width) })}${label("SOURCE INCLUDED", centerX, scaled(1098, width), scaled(24, width), "#B9F33A", { anchor: "middle", spacing: scaled(5, width) })}<circle cx="${formatNumber(scaled(760, width))}" cy="${formatNumber(scaled(900, width))}" r="${formatNumber(scaled(100, width))}" fill="none" stroke="#E1368C" stroke-width="${formatNumber(scaled(10, width))}" opacity=".86"/>`,
      );
    case "desktop":
      return canvasSvg(
        width,
        height,
        `<defs>${commonDefs}<linearGradient id="desktopSilver" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#F5F1EA"/><stop offset=".52" stop-color="#C9C5C1"/><stop offset="1" stop-color="#8E8F98"/></linearGradient><linearGradient id="desktopBlue" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#3657A9"/><stop offset="1" stop-color="#152557"/></linearGradient></defs><rect width="${width}" height="${height}" fill="#E9E3DD"/><rect y="0" width="${width}" height="${formatNumber(scaled(120, width))}" fill="#203B83"/><circle cx="${formatNumber(scaled(78, width))}" cy="${formatNumber(scaled(60, width))}" r="${formatNumber(scaled(22, width))}" fill="#EA3D91"/>${label("95", scaled(78, width), scaled(72, width), scaled(25, width), "white", { anchor: "middle", weight: 800 })}<g filter="url(#softShadow)">${wordmarkMarkup(scaled(660, width), centerX, scaled(270, width), "#111A37")}</g>${conceptWindow(122, 508, 380, 250, "url(#desktopBlue)", "#53A1FF", scale)}${conceptWindow(470, 608, 370, 260, "url(#desktopBlue)", "#53A1FF", scale)}${conceptWindow(278, 744, 400, 280, "url(#desktopBlue)", "#B9F33A", scale)}${label("AGENT CONTROL CENTER", scaled(390, width), scaled(1105, width), scaled(24, width), "#111A37", { anchor: "middle", spacing: scaled(3, width) })}<rect x="${formatNumber(scaled(670, width))}" y="${formatNumber(scaled(1050, width))}" width="${formatNumber(scaled(204, width))}" height="${formatNumber(scaled(62, width))}" rx="${formatNumber(scaled(5, width))}" fill="#EA3D91" transform="rotate(-7 ${formatNumber(scaled(772, width))} ${formatNumber(scaled(1081, width))})"/>${label("SOURCE INCLUDED", scaled(772, width), scaled(1090, width), scaled(16, width), "white", { anchor: "middle", weight: 800, spacing: scaled(2, width) })}`,
      );
    case "foil":
      return canvasSvg(
        width,
        height,
        `<defs>${commonDefs}<linearGradient id="foilBase" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#050B20"/><stop offset=".6" stop-color="#15164A"/><stop offset="1" stop-color="#32135C"/></linearGradient><linearGradient id="foilMark" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#FFFFFF"/><stop offset=".25" stop-color="#8E96A8"/><stop offset=".5" stop-color="#FDFDFD"/><stop offset=".7" stop-color="#696F9A"/><stop offset="1" stop-color="#E4E7F4"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#foilBase)"/><path d="M0 ${formatNumber(scaled(620, width))}L${width} ${formatNumber(scaled(490, width))}V${formatNumber(scaled(700, width))}L0 ${formatNumber(scaled(830, width))}Z" fill="#54259A" opacity=".9"/>${conceptCloud(-80, 880, 1.25, "#263EAA", 0.6, width)}${conceptCloud(620, 860, 1.1, "#8140D0", 0.63, width)}<g filter="url(#softShadow)">${wordmarkMarkup(scaled(650, width), centerX, scaled(300, width), "url(#foilMark)")}</g>${label("NIGHTLY", centerX, scaled(686, width), scaled(38, width), "white", { anchor: "middle", weight: 800, spacing: scaled(8, width) })}${label("SOURCE INCLUDED", centerX, scaled(1095, width), scaled(24, width), "#D7DFFF", { anchor: "middle", spacing: scaled(5, width) })}`,
      );
    case "lavender":
      return canvasSvg(
        width,
        height,
        `<defs>${commonDefs}<linearGradient id="lavenderTop" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#E1D4F4"/><stop offset="1" stop-color="#AAA5D4"/></linearGradient><linearGradient id="lavenderBottom" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#131E4B"/><stop offset="1" stop-color="#27165B"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#lavenderTop)"/><rect y="${formatNumber(scaled(540, width))}" width="${width}" height="${formatNumber(scaled(660, width))}" fill="url(#lavenderBottom)"/>${wordmarkMarkup(scaled(650, width), centerX, scaled(300, width), "#101A3C")}${label("NIGHTLY", scaled(770, width), scaled(510, width), scaled(28, width), "#101A3C", { anchor: "middle", weight: 800, spacing: scaled(4, width) })}${conceptCloud(-70, 820, 1.2, "#3B57B2", 0.66, width)}${conceptCloud(580, 850, 1.12, "#7542C7", 0.76, width)}${conceptWindow(140, 650, 340, 230, "#765AC5", "#65A8FF", scale)}${conceptWindow(480, 730, 350, 230, "#765AC5", "#65A8FF", scale)}${label("AGENT CONTROL CENTER", centerX, scaled(1085, width), scaled(26, width), "#E1D4F4", { anchor: "middle", spacing: scaled(3, width) })}${label("SOURCE INCLUDED", centerX, scaled(1125, width), scaled(19, width), "#AAA5D4", { anchor: "middle", spacing: scaled(4, width) })}`,
      );
  }
};

const renderConcepts = async (assets: Map<string, Buffer>): Promise<void> => {
  for (const output of CONCEPT_OUTPUTS) {
    const full = await rasterizeWebp(
      conceptSvg(output.concept, CONCEPT_WIDTH, CONCEPT_HEIGHT),
      CONCEPT_WIDTH,
      CONCEPT_HEIGHT,
    );
    for (const size of output.sizes) {
      if (size === 960) {
        addAsset(assets, `apps/marketing/public/95/t3-code-concepts/${output.stem}.webp`, full);
        continue;
      }
      const resized = await sharp(full)
        .resize({
          width: size,
          height: Math.round((size * CONCEPT_HEIGHT) / CONCEPT_WIDTH),
          fit: "fill",
        })
        .webp(WEBP_OPTIONS)
        .toBuffer();
      addAsset(
        assets,
        `apps/marketing/public/95/t3-code-concepts/${output.stem}-${size}.webp`,
        resized,
      );
    }
  }
};

const renderMarketingAssets = async (assets: Map<string, Buffer>): Promise<void> => {
  const stable = await renderIcon("production", MARKETING_ICON_SIZE);
  const nightly = await renderIcon("nightly", MARKETING_ICON_SIZE);
  addAsset(assets, "apps/marketing/src/assets/icon.webp", await pngToWebp(stable));
  addAsset(assets, "apps/marketing/src/assets/icon-nightly.webp", await pngToWebp(nightly));

  const productionVariant = ICON_VARIANTS.find((variant) => variant.brand === "production");
  if (!productionVariant) throw new Error("Production icon variant is missing.");
  const marketingCopies: ReadonlyArray<[string, string]> = [
    [productionVariant.outputs.faviconIco, "apps/marketing/public/favicon.ico"],
    [productionVariant.outputs.favicon16, "apps/marketing/public/favicon-16x16.png"],
    [productionVariant.outputs.favicon32, "apps/marketing/public/favicon-32x32.png"],
    [productionVariant.outputs.appleTouch, "apps/marketing/public/apple-touch-icon.png"],
  ];
  for (const [source, target] of marketingCopies) {
    const contents = assets.get(source);
    if (!contents) throw new Error(`Portable production icon is missing: ${source}`);
    addAsset(assets, target, contents);
  }
};

const generateAssets = async (): Promise<Map<string, Buffer>> => {
  const assets = new Map<string, Buffer>();
  await renderIconFamily(assets);
  await renderMarketingAssets(assets);
  await renderConcepts(assets);
  return assets;
};

const writeAsset = async (relativePath: string, contents: Buffer): Promise<void> => {
  const target = NodePath.join(ROOT, relativePath);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  const temporary = `${target}.portable-tmp`;
  await NodeFSP.writeFile(temporary, contents);
  await NodeFSP.rename(temporary, target);
};

const checkAssets = async (assets: Map<string, Buffer>): Promise<ReadonlyArray<string>> => {
  const stale: string[] = [];
  for (const [relativePath, expected] of assets) {
    try {
      const actual = await NodeFSP.readFile(NodePath.join(ROOT, relativePath));
      if (!actual.equals(expected)) stale.push(relativePath);
    } catch {
      stale.push(relativePath);
    }
  }
  return stale;
};

const main = async (): Promise<void> => {
  const checkOnly = process.argv.includes("--check");
  const assets = await generateAssets();
  if (checkOnly) {
    const stale = await checkAssets(assets);
    if (stale.length > 0) {
      throw new Error(
        `Portable generated assets are stale:\n${stale.map((path) => `- ${path}`).join("\n")}`,
      );
    }
    console.log(`All ${assets.size} portable brand assets are current.`);
    return;
  }

  for (const [relativePath, contents] of assets) await writeAsset(relativePath, contents);
  console.log(`Updated ${assets.size} portable brand assets.`);
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
