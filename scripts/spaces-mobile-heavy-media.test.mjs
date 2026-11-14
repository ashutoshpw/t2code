import { expect, it, vi } from "vite-plus/test";
import * as NodeModule from "node:module";
import {
  MobileSpaceImageBudget,
  MobileSpaceImageViewer,
} from "../apps/mobile/src/features/spaces/media.ts";
import { PdfPosition } from "../apps/mobile/src/lib/pdfPosition.ts";
import { TrackedPdfPreview } from "../apps/mobile/src/components/TrackedPdfPreview.tsx";
const platform = vi.hoisted(() => ({ downloads: [], views: [], active: 0 }));
vi.mock("../apps/mobile/node_modules/react-native", () => ({ View: ({ children }) => children }));
vi.mock("../apps/mobile/node_modules/react-native-pdf-jsi", async () => {
  const { useEffect } = await import("../apps/mobile/node_modules/react/index.js");
  return {
    default: (props) => {
      platform.views.push(props);
      useEffect(() => {
        platform.active++;
        return () => {
          platform.active--;
        };
      }, []);
      return null;
    },
  };
});
vi.mock("../apps/mobile/src/lib/attachmentDownload.ts", () => ({
  downloadAttachmentForPreview: (input) => {
    const result = Promise.withResolvers();
    platform.downloads.push({ ...input, result });
    return result.promise;
  },
}));
vi.mock("../apps/mobile/node_modules/expo-file-system", () => ({
  FileMode: { ReadOnly: "r" },
  File: class {
    open() {
      return { readBytes: async () => new TextEncoder().encode("%PDF-"), close: () => {} };
    }
  },
}));
vi.mock("../apps/mobile/src/features/files/FilePreviewFeedback.tsx", () => ({
  FilePreviewLoading: () => null,
  FilePreviewNotice: ({ children }) => children,
}));
vi.mock("../apps/mobile/src/components/ui/ControlPill.tsx", () => ({ ControlPill: () => null }));
vi.mock("../apps/mobile/src/lib/openExternalUrl.ts", () => ({ tryOpenExternalUrl: () => {} }));
const require = NodeModule.createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");

it("retains PDF file admission across late download cleanup, restores reported page on renewal, ignores retired bindings and unmounts over-page decoders", async () => {
  platform.downloads = [];
  platform.views = [];
  platform.active = 0;
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const budget = new MobileSpaceImageBudget("PDF or video");
  let sequence = 0;
  const create = () =>
    new MobileSpaceImageViewer(
      {
        budget,
        now: () => 0,
        access: () => ({
          capability: {
            version: 2,
            features: { assets: true },
            limits: { assets: { maxPdfBytes: 25 * 1024 * 1024 } },
          },
          httpBaseUrl: "https://selected.example",
          current: () => true,
        }),
        metadata: async () => ({
          assetId: "pdf",
          digest: "digest",
          byteSize: 100,
          mimeType: "application/pdf",
          name: "original.pdf",
        }),
        mint: async () => ({
          relativeUrl: `/api/assets/t${++sequence}/original.pdf`,
          fileRevision: "digest",
          expiresAt: 1000,
        }),
        share: async () => {},
      },
      "pdf",
    );
  const viewer = create(),
    next = create();
  const block = {
    id: "pdf-block",
    type: "pdf",
    version: 1,
    order: "a",
    parentId: null,
    content: { assetId: "pdf" },
  };
  const position = new PdfPosition();
  const owner = { position, hold: viewer.hold, current: () => viewer.current(), retry: () => {} };
  const render = (uri) =>
    act(async () => root.render(uri ? createElement(TrackedPdfPreview, { uri, owner }) : null));
  const disposal = vi.fn();
  try {
    await viewer.open(block, () => true);
    await render(viewer.url());
    expect(platform.downloads).toHaveLength(1);
    viewer.close();
    await render(null);
    expect(platform.downloads[0].signal.aborted).toBe(true);
    await next.open(block, () => true);
    expect(next.getSnapshot().assetId).toBeNull();
    await act(async () =>
      platform.downloads[0].result.resolve({ uri: "file:///late.pdf", dispose: disposal }),
    );
    expect(disposal).toHaveBeenCalledTimes(1);
    await viewer.open(block, () => true);
    await render(viewer.url());
    await act(async () =>
      platform.downloads[1].result.resolve({ uri: "file:///one.pdf", dispose: disposal }),
    );
    const old = platform.views.at(-1);
    await act(async () => {
      old.onLoadComplete(30);
      old.onPageChanged(7, 30);
    });
    await viewer.refresh();
    await render(viewer.url());
    await act(async () =>
      platform.downloads[2].result.resolve({ uri: "file:///renewed.pdf", dispose: disposal }),
    );
    const renewed = platform.views.at(-1);
    expect(renewed.page).toBe(7);
    await act(async () => old.onPageChanged(18, 30));
    expect(position.bind(() => true).initialPage).toBe(7);
    await act(async () => renewed.onLoadComplete(2001));
    expect(platform.active).toBe(0);
    viewer.close();
    await render(null);
    await next.open(block, () => true);
    expect(next.getSnapshot().assetId).toBe("pdf");
    next.close();
  } finally {
    viewer.close();
    next.close();
    for (const download of platform.downloads) download.result.resolve(null);
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  }
});
