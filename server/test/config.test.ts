import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("boots with an empty environment using defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.version).toBe("0.1.0");
    expect(config.logLevel).toBe("info");
    expect(config.strava.clientSecret).toBeUndefined();
  });

  it("treats blank values (as in .env.example) as unset", () => {
    const config = loadConfig({ PORT: "", DATA_DIR: "", LOG_LEVEL: "", PUBLIC_URL: "" });
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("info");
  });

  it("derives state paths from DATA_DIR and strips a trailing slash from PUBLIC_URL", () => {
    const config = loadConfig({
      DATA_DIR: "/srv/cameld",
      PUBLIC_URL: "https://cameld.example.com/",
    });
    expect(config.dataDir.replaceAll("\\", "/")).toMatch(/\/srv\/cameld$/);
    expect(config.dbPath.replaceAll("\\", "/")).toMatch(/\/srv\/cameld\/state\/cameld\.db$/);
    expect(config.publicUrl).toBe("https://cameld.example.com");
  });

  it("trims optional credentials and treats blank ones as unset", () => {
    const config = loadConfig({
      STRAVA_CLIENT_ID: "",
      STRAVA_CLIENT_SECRET: "   ",
      ALLOWED_EMAIL: " owner@example.com ",
    });
    expect(config.strava.clientId).toBeUndefined();
    expect(config.strava.clientSecret).toBeUndefined();
    expect(config.auth.allowedEmail).toBe("owner@example.com");
  });

  it("throws ConfigError naming the variable but never a secret value", () => {
    const attempt = () => loadConfig({ PORT: "not-a-port", SESSION_SECRET: "topsecretvalue" });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("PORT");
      expect(message).not.toContain("topsecretvalue");
    }
  });

  it("rejects an out-of-range port and a bad log level", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ LOG_LEVEL: "loud" })).toThrow(ConfigError);
  });

  it("reads the relay settings and strips a trailing slash", () => {
    const config = loadConfig({
      RELAY_URL: "https://relay.example.test/",
      RELAY_TOKEN: " synthetic ",
    });
    expect(config.relay).toEqual({ url: "https://relay.example.test", token: "synthetic" });
    expect(loadConfig({ RELAY_URL: "" }).relay.url).toBeUndefined();
    expect(() => loadConfig({ RELAY_URL: "not a url" })).toThrow(ConfigError);
  });

  it("reads the browser CDP endpoint", () => {
    expect(loadConfig({ BROWSER_CDP_URL: "http://browser.example.test:9222" }).browser).toEqual({
      cdpUrl: "http://browser.example.test:9222",
    });
    expect(loadConfig({ BROWSER_CDP_URL: "" }).browser.cdpUrl).toBeUndefined();
    expect(() => loadConfig({ BROWSER_CDP_URL: "nope" })).toThrow(ConfigError);
  });
});
