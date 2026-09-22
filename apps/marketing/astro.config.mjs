import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://t2.codes",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
