import { createHmac } from "node:crypto";

const crypto = {
  hmac(algorithm: string, secret: string, data: string, encoding: "hex" | "base64" = "hex"): string {
    return createHmac(algorithm, secret).update(data).digest(encoding);
  },
};

export default crypto;
