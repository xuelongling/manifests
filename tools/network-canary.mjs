// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2 || arguments_[0] !== "--out" || !arguments_[1]) {
  throw new Error("usage: network-canary.mjs --out <path>");
}

const endpoints = [
  { host: "1.1.1.1", port: 443 },
  { host: "8.8.8.8", port: 443 },
];

function probe({ host, port }) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let finished = false;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve({ endpoint: `${host}:${port}`, status });
    };
    socket.once("connect", () => finish("connected"));
    socket.once("error", () => finish("blocked"));
    socket.setTimeout(1_000, () => finish("blocked"));
  });
}

const canaries = await Promise.all(endpoints.map(probe));
const connected = canaries.find((entry) => entry.status === "connected");
if (connected) throw new Error(`network canary unexpectedly connected to ${connected.endpoint}`);

const output = path.resolve(arguments_[1]);
await mkdir(path.dirname(output), { recursive: true });
const temporary = `${output}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, `${JSON.stringify({ canaries, schemaVersion: "1", status: "success" })}\n`, { flag: "wx" });
  await rename(temporary, output);
} catch (error) {
  await rm(temporary, { force: true });
  throw error;
}
