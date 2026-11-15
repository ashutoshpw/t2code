import { expect } from "e2e";

import { test, WEB } from "./t2.ts";

test(
  "An expanded command shows the JSON line it printed, keys and all",
  WEB,
  async ({ t2, app, screen }) => {
    const project = await t2.project("demo");
    const thread = await t2.thread({
      project,
      title: "JSON output",
      messages: ["Print the JSON"],
      model: "command-output",
    });
    await t2.open(thread);

    await expect(screen.getByText("The command printed one JSON line.")).toBeVisible();
    await screen.getByRole("button", "Worked for", { exact: false }).tap();
    await screen.getByRole("button", "node -e", { exact: false }).first().tap();
    await app.screenshot("expanded");
    await expect(screen.getByText('"requestId":"keep-me"', { exact: false })).toBeVisible();
  },
);
