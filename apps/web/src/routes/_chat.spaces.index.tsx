import { createFileRoute } from "@tanstack/react-router";
import { SpacesLanding } from "../spaces/SpacesLanding";
export const Route = createFileRoute("/_chat/spaces/")({ component: SpacesLanding });
