import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExecutionReverted } from "../errors";
import { data, mockRpc, policy } from "./helpers";
// Load the repository's actual compiler and pooled executor, not a replica.
const { compilePlugin } = require("../../../plugins/lib/compiler") as {
  compilePlugin: (
    path: string,
    options: { baseDir: string },
  ) => Promise<{ code: string }>;
};
const executePlugin = require("../../../plugins/lib/pool-executor").default as (
  task: unknown,
) => Promise<{
  success: boolean;
  result?: { transactionId?: string };
  error?: unknown;
}>;

test("actual pooled runtime bundles and invokes plugin over its relayer socket protocol", async () => {
  const dir = await mkdtemp(join(tmpdir(), "steer-plugin-"));
  const socketPath = join(dir, "relay.sock");
  const sockets = new Set<Socket>();
  const queued: unknown[] = [];
  const { rpc } = mockRpc();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line);
        void (async () => {
          assert.equal(request.relayerId, "keeper");
          let result: unknown;
          if (request.method === "getRelayer")
            result = {
              id: "keeper",
              network_type: "evm",
              address: "0x1000000000000000000000000000000000000001",
              paused: false,
            };
          else if (request.method === "rpc")
            result = {
              jsonrpc: "2.0",
              id: request.payload.id,
              ...(await rpc(
                request.payload.method,
                request.payload.params,
              ).then(
                (result) => ({ result }),
                (error) => {
                  if (error instanceof ExecutionReverted)
                    return {
                      error: { code: 3, message: "execution reverted" },
                    };
                  throw error;
                },
              )),
            };
          else if (request.method === "sendTransaction") {
            queued.push(request.payload);
            result = { id: "pooled-tx", relayer_id: "keeper" };
          } else throw new Error("Unexpected socket method " + request.method);
          socket.write(
            JSON.stringify({ requestId: request.requestId, result }) + "\n",
          );
        })().catch((error) =>
          socket.write(
            JSON.stringify({
              requestId: request.requestId,
              error: String(error),
            }) + "\n",
          ),
        );
      }
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const root = resolve(__dirname, "..");
    const compiled = await compilePlugin(join(root, "index.ts"), {
      baseDir: root,
    });
    const result = await executePlugin({
      taskId: "steer-runtime-test",
      pluginId: "steer-action",
      compiledCode: compiled.code,
      params: { data, mode: "submit" },
      socketPath,
      timeout: 10000,
      config: policy,
      method: "POST",
    });
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.result?.transactionId, "pooled-tx");
    assert.equal(queued.length, 1);
    assert.equal((queued[0] as { data: string }).data, data);
    assert.equal((queued[0] as { gas_limit: number }).gas_limit, 550000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
