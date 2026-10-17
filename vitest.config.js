import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            RESEND_API_KEY: "re_test_not_real",
            TURNSTILE_SECRET: "test-secret",
            IP_HASH_KEY: "test-ip-key",
            PAYHIP_API_KEY: "test-payhip-key",
            // Override anything a developer's local .dev.vars might set.
            EMAIL_MODE: "",
            TURNSTILE_SITE_KEY: "0x4AAAAAAFY-xUUqJQoVXeUt",
            TURNSTILE_EXPECTED_HOSTNAME: "llmentzero.com",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.js"] },
  };
});
