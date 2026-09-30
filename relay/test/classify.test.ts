import { describe, expect, it } from "vitest";

import {
  classify,
  domainAllowed,
  domainOf,
  extractOtp,
  isAllowedSender,
  pickNearest,
} from "../src/classify.ts";

describe("sender allowlist", () => {
  it("accepts strava.com and its subdomains, anchored at a label boundary", () => {
    expect(isAllowedSender("no-reply@strava.com")).toBe(true);
    expect(isAllowedSender("NO-REPLY@Mail.Strava.com")).toBe(true);
    expect(isAllowedSender("x@notstrava.com")).toBe(false);
    expect(isAllowedSender("x@strava.com.attacker.example")).toBe(false);
    expect(isAllowedSender("someone@gmail.com")).toBe(false);
    expect(isAllowedSender("")).toBe(false);
  });

  it("accepts only Gmail's exact forwarding sender from google.com", () => {
    expect(isAllowedSender("forwarding-noreply@google.com")).toBe(true);
    expect(isAllowedSender("other@google.com")).toBe(false);
  });

  it("domain helpers", () => {
    expect(domainOf("a@B.Example")).toBe("b.example");
    expect(domainOf("nope")).toBe("");
    expect(domainAllowed("", ["strava.com"])).toBe(false);
    expect(domainAllowed("strava.com", [" ", "STRAVA.com"])).toBe(true);
  });
});

describe("extractOtp", () => {
  it("takes a six digit code from the subject first", () => {
    expect(extractOtp("Your code is 482913", "ignored 111111")).toBe("482913");
  });

  it("finds the code after a keyword in the body, skipping durations", () => {
    const text =
      "Order 555555 shipped.\nYour verification code is 204817. It expires in 10 minutes.";
    expect(extractOtp("Your login code", text)).toBe("204817");
  });

  it("ignores a six digit run followed by minutes and phone segments", () => {
    expect(extractOtp("", "code: 100000 minutes")).toBeNull();
    expect(extractOtp("", "Call code line 555-123456-7")).toBeNull();
  });

  it("does not trust digits with no code-ish word", () => {
    expect(extractOtp("Hello", "Invoice 123456")).toBeNull();
  });

  it("falls back to the nearest candidate before an anchor", () => {
    expect(extractOtp("", "731902 is your code")).toBe("731902");
  });

  it("pickNearest edge cases", () => {
    expect(pickNearest([], [1])).toBeNull();
    expect(pickNearest([{ value: "123456", index: 3 }], [])).toBe("123456");
  });
});

describe("classify", () => {
  it("classifies a Strava code mail as otp", () => {
    expect(
      classify({ from: "no-reply@strava.com", subject: "Your code", text: "Code: 918273" }),
    ).toEqual({ kind: "otp", code: "918273", url: null });
  });

  it("classifies a codeless Strava mail as other", () => {
    expect(classify({ from: "no-reply@strava.com", subject: "Kudos!", text: "Nice run" })).toEqual({
      kind: "other",
      code: null,
      url: null,
    });
  });

  it("extracts Gmail's forwarding confirmation code and pinned link", () => {
    const text = [
      "relay@example.test has requested to automatically forward mail.",
      "Confirmation code: 987654321",
      "https://mail-settings.google.com/mail/vf-synthetic-token",
    ].join("\n");
    expect(
      classify({ from: "forwarding-noreply@google.com", subject: "Gmail Forwarding", text }),
    ).toEqual({
      kind: "forward_verify",
      code: "987654321",
      url: "https://mail-settings.google.com/mail/vf-synthetic-token",
    });
  });

  it("drops a forwarding link on another host or with a redirector param", () => {
    const other = classify({
      from: "forwarding-noreply@google.com",
      subject: "x",
      text: "https://attacker.example/x code 12345678",
    });
    expect(other.url).toBeNull();
    expect(other.code).toBe("12345678");
    const redirect = classify({
      from: "forwarding-noreply@google.com",
      subject: "x",
      text: "https://mail-settings.google.com/mail/vf?continue=https://attacker.example",
    });
    expect(redirect).toEqual({ kind: "forward_verify", code: null, url: null });
  });
});
