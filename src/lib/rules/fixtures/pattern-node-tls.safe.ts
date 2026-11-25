import https from "node:https";

// SAFE: rejectUnauthorized is true (default) with trusted root CA
const agent = new https.Agent({
  rejectUnauthorized: true,
});
