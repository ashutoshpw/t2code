import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render, stubGlobal } from "../../../../test/render";
import { SharedFormPage } from "./SharedForm";

const FORM = {
  viewId: "v1",
  title: "Feedback",
  questions: [
    { propertyId: "title", type: "title", label: "Your name", required: true },
    {
      propertyId: "kind",
      type: "select",
      label: "Kind",
      required: false,
      options: [
        { id: "bug", name: "Bug", color: "red" },
        { id: "idea", name: "Idea", color: "blue" },
      ],
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(
  get: () => Response,
  post: (body: { submissionId: string; answers: Record<string, unknown> }) => Response,
) {
  const posts: Array<{
    headers: Headers;
    body: { submissionId: string; answers: Record<string, unknown> };
  }> = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== "POST") return get();
    const body = JSON.parse(String(init.body));
    posts.push({ headers: new Headers(init.headers), body });
    return post(body);
  });
  return { fetch, posts };
}

const props = { credential: "cred.sig", pageId: "p1", blockId: "b1", viewId: "v1" };

describe("SharedFormPage", () => {
  it("posts the answers with the credential header and a submission id", async () => {
    const stub = stubFetch(
      () => json(FORM),
      () => json({ status: "received" }),
    );
    using _fetch = stubGlobal("fetch", stub.fetch);
    await using screen = await render(<SharedFormPage {...props} />, { router: "/" });

    await userEvent.fill(screen.getByRole("textbox", { name: /Your name/ }), "Ada");
    await userEvent.click(screen.getByRole("radio", { name: "Bug" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    await expect.element(screen.getByText("Thanks, your response was recorded.")).toBeVisible();
    expect(stub.posts).toHaveLength(1);
    expect(stub.posts[0]!.headers.get("x-t2-page-share")).toBe("cred.sig");
    expect(stub.posts[0]!.body.answers).toEqual({ title: "Ada", kind: "bug" });
    expect(stub.posts[0]!.body.submissionId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("shows the closed note when the form is not accepting responses", async () => {
    const stub = stubFetch(
      () => json({ reason: "closed", message: "closed" }, 403),
      () => json({}),
    );
    using _fetch = stubGlobal("fetch", stub.fetch);
    await using screen = await render(<SharedFormPage {...props} />, { router: "/" });
    await expect.element(screen.getByText("This form is not accepting responses.")).toBeVisible();
  });

  it("marks the field the server rejected", async () => {
    const stub = stubFetch(
      () => json(FORM),
      () =>
        json({ reason: "rejected", message: "no", propertyId: "title", problem: "too_long" }, 422),
    );
    using _fetch = stubGlobal("fetch", stub.fetch);
    await using screen = await render(<SharedFormPage {...props} />, { router: "/" });
    await userEvent.fill(screen.getByRole("textbox", { name: /Your name/ }), "Ada");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await expect.element(screen.getByText("This answer is too long.")).toBeVisible();
    await expect
      .element(screen.getByRole("textbox", { name: /Your name/ }))
      .toHaveAttribute("aria-invalid", "true");
  });

  it("reuses the submission id when the same answers are retried after going offline", async () => {
    let attempt = 0;
    const stub = stubFetch(
      () => json(FORM),
      () =>
        attempt++ === 0
          ? json({ reason: "failed", message: "x" }, 503)
          : json({ status: "received" }),
    );
    using _fetch = stubGlobal("fetch", stub.fetch);
    await using screen = await render(<SharedFormPage {...props} />, { router: "/" });
    await userEvent.fill(screen.getByRole("textbox", { name: /Your name/ }), "Ada");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await expect.element(screen.getByText(/Can't reach the owner/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await expect.element(screen.getByText("Thanks, your response was recorded.")).toBeVisible();
    expect(stub.posts).toHaveLength(2);
    expect(stub.posts[1]!.body.submissionId).toBe(stub.posts[0]!.body.submissionId);
  });
});
