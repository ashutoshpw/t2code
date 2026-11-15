import { expect } from "e2e";

import { test, WEB } from "./t2.ts";

test(
  "A seeded thread opens by its link and shows its history",
  WEB,
  async ({ t2, app, screen }) => {
    const project = await t2.project("demo");
    const thread = await t2.thread({
      project,
      title: "Earlier work",
      messages: ["first", "second"],
    });
    await t2.open(thread);

    await expect(screen.getByText("second fixture turn complete", { exact: false })).toBeVisible();
    await app.screenshot("thread");
  },
);
