import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@t2code/marketing...'",
  buildCommand: "vp run --filter @t2code/marketing build",
  outputDirectory: "dist",
};
