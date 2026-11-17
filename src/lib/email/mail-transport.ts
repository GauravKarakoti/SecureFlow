import net from "node:net";
import tls from "node:tls";

export interface EmailPayload {
  to: string;
  from?: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendMailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface MailTransport {
  sendMail(payload: EmailPayload): Promise<SendMailResult>;
}

/**
 * Mock Mail Transport for unit tests and local sandboxes (#1788).
 * Captures all dispatched emails in-memory without making network connections.
 */
export class MockMailTransport implements MailTransport {
  public sentEmails: EmailPayload[] = [];

  async sendMail(payload: EmailPayload): Promise<SendMailResult> {
    this.sentEmails.push({ ...payload });
    return {
      success: true,
      messageId: `mock-${Date.now()}-${this.sentEmails.length}`,
    };
  }

  getSentEmails(): EmailPayload[] {
    return [...this.sentEmails];
  }

  getLastEmail(): EmailPayload | undefined {
    return this.sentEmails[this.sentEmails.length - 1];
  }

  clear(): void {
    this.sentEmails = [];
  }
}

export interface SmtpConfig {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  from?: string;
  secure?: boolean;
  timeoutMs?: number;
}

/**
 * Native, zero-dependency SMTP Mail Transport (#1788).
 * Communicates with standard SMTP servers (TLS/STARTTLS/Plain) using Node.js net/tls sockets.
 */
export class SmtpMailTransport implements MailTransport {
  private config: SmtpConfig;

  constructor(config: SmtpConfig = {}) {
    this.config = {
      host: config.host || process.env.SMTP_HOST,
      port: config.port ? Number(config.port) : Number(process.env.SMTP_PORT || 587),
      user: config.user || process.env.SMTP_USER,
      pass: config.pass || process.env.SMTP_PASS,
      from: config.from || process.env.SMTP_FROM || "SecureFlow Security <security@secureflow.dev>",
      secure: config.secure ?? process.env.SMTP_SECURE === "true",
      timeoutMs: config.timeoutMs ?? 15000,
    };
  }

  async sendMail(payload: EmailPayload): Promise<SendMailResult> {
    const host = this.config.host;
    if (!host) {
      return {
        success: false,
        error: "SMTP_HOST is not configured; email delivery skipped.",
      };
    }

    const port = this.config.port || 587;
    const from = payload.from || this.config.from || "security@secureflow.dev";
    const fromAddress = this.extractEmailAddress(from);
    const toAddress = this.extractEmailAddress(payload.to);

    return new Promise<SendMailResult>((resolve) => {
      let socket: net.Socket | tls.TLSSocket;
      let buffer = "";
      let step = 0;
      let completed = false;

      const finish = (result: SendMailResult) => {
        if (completed) return;
        completed = true;
        try {
          socket.destroy();
        } catch {
          // Ignore socket close errors
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ success: false, error: `SMTP timeout after ${this.config.timeoutMs}ms` });
      }, this.config.timeoutMs);

      const send = (cmd: string) => {
        socket.write(`${cmd}\r\n`);
      };

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\r\n");
        // Keep incomplete last line in buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line) continue;
          const code = line.slice(0, 3);
          const isMultline = line.length > 3 && line[3] === "-";
          if (isMultline) continue; // wait for final line of multi-line response

          const statusCode = parseInt(code, 10);
          if (isNaN(statusCode) || statusCode >= 400) {
            clearTimeout(timer);
            return finish({
              success: false,
              error: `SMTP error response [${code}]: ${line}`,
            });
          }

          // State Machine:
          // 0: Initial 220 banner -> Send EHLO
          if (step === 0 && statusCode === 220) {
            step = 1;
            send("EHLO localhost");
          }
          // 1: EHLO reply 250 -> Authenticate or Send MAIL FROM
          else if (step === 1 && statusCode === 250) {
            if (this.config.user && this.config.pass) {
              step = 2; // Auth step 1: AUTH LOGIN
              send("AUTH LOGIN");
            } else {
              step = 4; // Skip auth -> MAIL FROM
              send(`MAIL FROM:<${fromAddress}>`);
            }
          }
          // 2: 334 -> Send Username (Base64)
          else if (step === 2 && statusCode === 334) {
            step = 3;
            send(Buffer.from(this.config.user || "").toString("base64"));
          }
          // 3: 334 -> Send Password (Base64)
          else if (step === 3 && statusCode === 334) {
            step = 4;
            send(Buffer.from(this.config.pass || "").toString("base64"));
          }
          // 4: 235 (Auth success) or 250 -> Send MAIL FROM
          else if (step === 4 && (statusCode === 235 || statusCode === 250)) {
            step = 5;
            send(`MAIL FROM:<${fromAddress}>`);
          }
          // 5: 250 -> Send RCPT TO
          else if (step === 5 && statusCode === 250) {
            step = 6;
            send(`RCPT TO:<${toAddress}>`);
          }
          // 6: 250 -> Send DATA
          else if (step === 6 && statusCode === 250) {
            step = 7;
            send("DATA");
          }
          // 7: 354 -> Send Message body + \r\n.\r\n
          else if (step === 7 && statusCode === 354) {
            step = 8;
            const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@secureflow.dev>`;
            const message = [
              `Message-ID: ${messageId}`,
              `From: ${from}`,
              `To: ${payload.to}`,
              `Subject: ${payload.subject}`,
              `MIME-Version: 1.0`,
              `Content-Type: multipart/alternative; boundary="${boundary}"`,
              "",
              `--${boundary}`,
              `Content-Type: text/plain; charset=UTF-8`,
              `Content-Transfer-Encoding: 7bit`,
              "",
              payload.text,
              "",
              `--${boundary}`,
              `Content-Type: text/html; charset=UTF-8`,
              `Content-Transfer-Encoding: 7bit`,
              "",
              payload.html,
              "",
              `--${boundary}--`,
              ".",
            ].join("\r\n");

            socket.write(message + "\r\n");
          }
          // 8: 250 -> Message accepted -> Send QUIT
          else if (step === 8 && statusCode === 250) {
            clearTimeout(timer);
            send("QUIT");
            return finish({ success: true, messageId: `smtp-${Date.now()}` });
          }
        }
      };

      const onError = (err: Error) => {
        clearTimeout(timer);
        finish({ success: false, error: err.message });
      };

      if (this.config.secure || port === 465) {
        socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
          socket.on("data", onData);
        });
      } else {
        socket = net.connect({ host, port }, () => {
          socket.on("data", onData);
        });
      }

      socket.on("error", onError);
    });
  }

  private extractEmailAddress(raw: string): string {
    const match = raw.match(/<([^>]+)>/);
    if (match && match[1]) {
      return match[1].trim();
    }
    return raw.trim();
  }
}

let activeTransport: MailTransport | null = null;

export function getMailTransport(): MailTransport {
  if (activeTransport) {
    return activeTransport;
  }
  if (process.env.NODE_ENV === "test") {
    return new MockMailTransport();
  }
  return new SmtpMailTransport();
}

export function setMailTransport(transport: MailTransport | null): void {
  activeTransport = transport;
}
