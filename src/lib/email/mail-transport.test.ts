import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MockMailTransport,
  BrevoMailTransport,
  SmtpMailTransport,
  getMailTransport,
  setMailTransport,
  parseEmailAndName,
} from "./mail-transport";

describe("mail-transport", () => {
  describe("parseEmailAndName", () => {
    it("parses name and email from RFC address format", () => {
      const res = parseEmailAndName("SecureFlow Security <security@secureflow.dev>");
      expect(res).toEqual({
        name: "SecureFlow Security",
        email: "security@secureflow.dev",
      });
    });

    it("handles quoted names", () => {
      const res = parseEmailAndName('"Alerts Bot" <alerts@example.com>');
      expect(res).toEqual({
        name: "Alerts Bot",
        email: "alerts@example.com",
      });
    });

    it("handles bare email address", () => {
      const res = parseEmailAndName("security@secureflow.dev");
      expect(res).toEqual({
        email: "security@secureflow.dev",
      });
    });
  });

  describe("MockMailTransport", () => {
    it("stores sent emails and allows retrieval and clearing", async () => {
      const transport = new MockMailTransport();
      const payload = {
        to: "developer@example.com",
        subject: "Security Digest",
        text: "Summary text",
        html: "<p>Summary html</p>",
      };

      const res = await transport.sendMail(payload);
      expect(res.success).toBe(true);
      expect(res.messageId).toBeDefined();
      expect(transport.getSentEmails()).toHaveLength(1);
      expect(transport.getLastEmail()?.to).toBe("developer@example.com");

      transport.clear();
      expect(transport.getSentEmails()).toHaveLength(0);
      expect(transport.getLastEmail()).toBeUndefined();
    });
  });

  describe("BrevoMailTransport", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("returns error if BREVO_API_KEY is not configured", async () => {
      const transport = new BrevoMailTransport({ apiKey: "" });
      const res = await transport.sendMail({
        to: "user@example.com",
        subject: "Test",
        text: "Test",
        html: "<p>Test</p>",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("BREVO_API_KEY is not configured");
    });

    it("sends email successfully to Brevo REST API v3", async () => {
      let capturedUrl = "";
      let capturedOptions: any = null;

      global.fetch = vi.fn().mockImplementation(async (url, options) => {
        capturedUrl = String(url);
        capturedOptions = options;
        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: "<brevo-test-12345@smtp-relay.brevo.com>" }),
        };
      });

      const transport = new BrevoMailTransport({
        apiKey: "xkeysib-test-token",
        senderEmail: "alerts@secureflow.dev",
        senderName: "SecureFlow Alerts",
      });

      const res = await transport.sendMail({
        to: "John Doe <john@example.com>",
        from: "Security Team <security@secureflow.dev>",
        subject: "Weekly Digest",
        text: "Plain content",
        html: "<p>HTML content</p>",
      });

      expect(res.success).toBe(true);
      expect(res.messageId).toBe("<brevo-test-12345@smtp-relay.brevo.com>");
      expect(capturedUrl).toBe("https://api.brevo.com/v3/smtp/email");
      expect(capturedOptions.method).toBe("POST");
      expect(capturedOptions.headers["api-key"]).toBe("xkeysib-test-token");
      expect(capturedOptions.headers["Content-Type"]).toBe("application/json");

      const parsedBody = JSON.parse(capturedOptions.body);
      expect(parsedBody.sender).toEqual({
        name: "Security Team",
        email: "security@secureflow.dev",
      });
      expect(parsedBody.to).toEqual([
        {
          name: "John Doe",
          email: "john@example.com",
        },
      ]);
      expect(parsedBody.subject).toBe("Weekly Digest");
      expect(parsedBody.htmlContent).toBe("<p>HTML content</p>");
      expect(parsedBody.textContent).toBe("Plain content");
    });

    it("handles Brevo HTTP error responses gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Key not found",
      });

      const transport = new BrevoMailTransport({
        apiKey: "invalid-key",
      });

      const res = await transport.sendMail({
        to: "user@example.com",
        subject: "Test",
        text: "Test",
        html: "<p>Test</p>",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("Brevo API error [401]: Key not found");
    });

    it("handles network failure or timeout gracefully", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

      const transport = new BrevoMailTransport({
        apiKey: "test-key",
      });

      const res = await transport.sendMail({
        to: "user@example.com",
        subject: "Test",
        text: "Test",
        html: "<p>Test</p>",
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe("Network timeout");
    });
  });

  describe("SmtpMailTransport", () => {
    it("returns error if SMTP_HOST is not configured", async () => {
      const transport = new SmtpMailTransport({ host: "" });
      const res = await transport.sendMail({
        to: "user@example.com",
        subject: "Test",
        text: "Test",
        html: "<p>Test</p>",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("SMTP_HOST is not configured");
    });
  });

  describe("getMailTransport and setMailTransport", () => {
    afterEach(() => {
      setMailTransport(null);
    });

    it("returns MockMailTransport in test environment by default", () => {
      const transport = getMailTransport();
      expect(transport).toBeInstanceOf(MockMailTransport);
    });

    it("allows setting a custom transport instance", () => {
      const custom = new MockMailTransport();
      setMailTransport(custom);
      expect(getMailTransport()).toBe(custom);
    });
  });
});
