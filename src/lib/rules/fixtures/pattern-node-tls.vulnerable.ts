import https from "node:https";

// INSECURE: rejectUnauthorized: false disables certificate validation
const agent = new https.Agent({
  rejectUnauthorized: false,
});
