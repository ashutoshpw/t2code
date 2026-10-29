import { createFileRoute } from "@tanstack/react-router";

import { SharedPage } from "../components/sharedPage/SharedPage";

export const Route = createFileRoute("/shared-page")({
  component: SharedPage,
});
