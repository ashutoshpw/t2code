import { describe, expect, it, vi } from "vite-plus/test";

import { dataSource, property } from "./databaseFixtures.test-support";
import { submitFormResponse } from "./formResponse";

const source = dataSource([property("title", "Name", "title"), property("note", "Note", "text")]);
const questions = [
  {
    propertyId: "title",
    type: "title",
    label: "Name",
    description: undefined,
    required: true,
    options: [],
  },
  {
    propertyId: "note",
    type: "text",
    label: "Note",
    description: undefined,
    required: false,
    options: [],
  },
] as never;

function harness(canWrite: boolean) {
  const createRows = vi.fn(async () => ({ rows: [{ pageId: "page1" }] }));
  const flush = vi.fn(async () => undefined);
  const track = vi.fn(async (_id: unknown, _options: unknown, run: () => Promise<unknown>) =>
    run(),
  );
  return {
    createRows,
    flush,
    track,
    args: {
      environmentId: "env1",
      registry: {},
      mutations: { createRows },
      writer: { flush, track },
      canWrite: () => canWrite,
      dataSource: source,
      questions,
      answers: { title: " Ada ", note: "Hi" },
    } as never as Parameters<typeof submitFormResponse>[0],
  };
}

describe("submitFormResponse", () => {
  it("creates one row from the answers: title apart, text as runs, no template", async () => {
    const { args, createRows, flush } = harness(true);
    const result = await submitFormResponse(args);
    expect(result).toEqual({ ok: true, pageId: "page1" });
    expect(flush).toHaveBeenCalledOnce();
    expect(createRows).toHaveBeenCalledOnce();
    expect(createRows).toHaveBeenCalledWith({}, "env1", {
      dataSourceId: "source1",
      rows: [{ title: "Ada", cells: { note: [{ text: "Hi", marks: [] }] } }],
    });
  });

  it("refuses without write access and creates nothing", async () => {
    const { args, createRows } = harness(false);
    const result = await submitFormResponse(args);
    expect(result.ok).toBe(false);
    expect(createRows).not.toHaveBeenCalled();
  });
});
