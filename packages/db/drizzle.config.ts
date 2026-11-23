import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? "postgres://orbit:orbit@localhost:5432/orbit",
  },
});
