"use strict";

const readline = require("node:readline");

function validInput(input) {
  try {
    const url = new URL(input.url);
    const keys = [...url.searchParams.keys()];
    return typeof input.host === "string" && url.protocol === "wss:" &&
      url.host === input.host && !url.username && !url.password && !url.hash &&
      url.pathname === "/client/hubs/adventureworks" &&
      keys.length === 1 && keys[0] === "access_token" && !!url.searchParams.get("access_token") &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.probeId);
  } catch {
    return false;
  }
}

function matchesMessage(raw, probeId) {
  try {
    const message = JSON.parse(raw);
    return message.type === "message" && message.from === "group" &&
      message.group === "utilities" && message.dataType === "json" &&
      message.data?.event === "auth-assurance-probe" && message.data?.probeId === probeId;
  } catch {
    return false;
  }
}

function listen(input) {
  let finished = false;
  const finish = (line, code) => {
    if (finished) return;
    finished = true;
    process.stdout.write(line + "\n", () => process.exit(code));
  };
  if (!validInput(input)) return finish("SOCKET_FAILED", 1);
  const timeout = setTimeout(() => finish("SOCKET_FAILED", 1), 420000);
  const socket = new WebSocket(input.url, "json.webpubsub.azure.v1");
  socket.addEventListener("open", () => console.log("SOCKET_READY"));
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string" && matchesMessage(event.data, input.probeId)) {
      clearTimeout(timeout);
      socket.close();
      finish("MESSAGE_RECEIVED", 0);
    }
  });
  socket.addEventListener("error", () => finish("SOCKET_FAILED", 1));
  socket.addEventListener("close", () => finish("SOCKET_FAILED", 1));
}

if (require.main === module) {
  const input = readline.createInterface({ input: process.stdin });
  input.once("line", (line) => {
    input.close();
    try { listen(JSON.parse(line)); }
    catch { process.stdout.write("SOCKET_FAILED\n", () => process.exit(1)); }
  });
} else {
  module.exports = { validInput, matchesMessage };
}
