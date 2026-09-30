import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  ContractFactory,
  Interface,
  JsonRpcProvider,
  keccak256,
  toQuantity,
} from "ethers";
import solc from "solc";
import {
  ACTION_ABI,
  CODE_COPY,
  estimateAction,
  requireCompleted,
  type Rpc,
  type Policy,
} from "../gas";
import guard from "../guard-runtime.json";
let anvil: ChildProcess;
let rpc: Rpc;
let provider: JsonRpcProvider;
let sender: string;
let proxy: string;
let implementation: string;
let target: string;
let policy: Policy;
let burn: string;
let fail: string;
let data: string;
let snapshot: string;

before(
  async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing port");
        server.close(() => resolve(address.port));
      });
    });
    anvil = spawn(
      process.env.ANVIL_BIN || "anvil",
      [
        "--port",
        String(port),
        "--chain-id",
        "31337",
        "--gas-limit",
        "30000000",
        "--silent",
      ],
      { stdio: "ignore" },
    );
    let startError: Error | undefined;
    anvil.on("error", (e) => {
      startError = e;
    });
    let id = 0;
    rpc = async (method, params) => {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(10000),
      });
      const body = (await response.json()) as {
        result: unknown;
        error?: { message: string };
      };
      if (body.error) throw new Error(body.error.message);
      return body.result;
    };
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (startError)
        throw new Error(
          "Install Anvil or set ANVIL_BIN: " + startError.message,
        );
      try {
        await rpc("eth_chainId", []);
        ready = true;
        break;
      } catch {
        await delay(100);
      }
    }
    if (!ready) throw new Error("Local Anvil did not start");
    provider = new JsonRpcProvider(`http://127.0.0.1:${port}`);
    const signer = await provider.getSigner(0);
    sender = await signer.getAddress();
    const compiled = JSON.parse(
      solc.compile(
        JSON.stringify({
          language: "Solidity",
          sources: {
            "fixtures.sol": {
              content: readFileSync(__dirname + "/fixtures.sol", "utf8"),
            },
          },
          settings: {
            evmVersion: "paris",
            optimizer: { enabled: true, runs: 200 },
            outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
          },
        }),
      ),
    );
    const errors = (compiled.errors || []).filter(
      (e: { severity: string }) => e.severity === "error",
    );
    assert.deepEqual(errors, []);
    async function deploy(name: string, args: unknown[] = []) {
      const artifact = compiled.contracts["fixtures.sol"][name];
      const deployed = await new ContractFactory(
        artifact.abi,
        "0x" + artifact.evm.bytecode.object,
        signer,
      ).deploy(...args);
      await deployed.waitForDeployment();
      return deployed.getAddress();
    }
    implementation = await deploy("FixtureOrchestrator", [sender]);
    proxy = await deploy("FixtureProxy", [implementation]);
    target = await deploy("FixtureTarget");
    snapshot = (await rpc("eth_blockNumber", [])) as string;
    policy = {
      relayerId: "local",
      chainId: "31337",
      orchestrator: proxy,
      proxyCodeHash: keccak256(await provider.getCode(proxy)),
      implementationCodeHash: keccak256(await provider.getCode(implementation)),
      maxGas: 1500000,
      maxGasPrice: "2000000000",
      marginBps: 1000,
      maxSnapshotAgeSeconds: 60,
    };
    const targetAbi = new Interface([
      "function burn(uint256)",
      "function fail()",
    ]);
    burn = targetAbi.encodeFunctionData("burn", [1000]);
    fail = targetAbi.encodeFunctionData("fail");
    data = ACTION_ABI.encodeFunctionData("executeAction", [
      target,
      1,
      [burn],
      [],
      "0x" + "00".repeat(32),
    ]);
  },
  { timeout: 20000 },
);
after(async () => {
  provider?.destroy();
  if (anvil && anvil.exitCode === null) {
    anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => anvil.once("exit", () => resolve()));
  }
});

test("guard turns caught inner OOG into revert without changing keeper/self-call identity", async () => {
  const overrides = {
    [proxy]: { code: guard.runtime },
    [CODE_COPY]: { code: await provider.getCode(proxy) },
  };
  const tx = {
    from: sender,
    to: proxy,
    data,
    value: "0x0",
    gasPrice: "0x3b9aca00",
    gas: "0x186a0",
  };
  const ordinary = await rpc("eth_call", [tx, snapshot]);
  assert.equal(BigInt(ordinary as string), 0n);
  await assert.rejects(rpc("eth_call", [tx, snapshot, overrides]), /revert/);
  requireCompleted(
    await rpc("eth_call", [
      { ...tx, gas: toQuantity(policy.maxGas) },
      snapshot,
      overrides,
    ]),
  );
});
test("guarded estimation selects gas that completes original execution; simulation leaves storage/code unchanged", async () => {
  const beforeProxy = await provider.getCode(proxy);
  const beforeTarget = await rpc("eth_getStorageAt", [target, "0x0", snapshot]);
  const beforeExecutions = await rpc("eth_getStorageAt", [
    proxy,
    "0x0",
    snapshot,
  ]);
  const report = await estimateAction(
    rpc,
    policy,
    { data, mode: "estimate" },
    sender,
    { blockTag: snapshot, gasPrice: "1000000000" },
  );
  requireCompleted(
    await rpc("eth_call", [
      { ...report.transaction, gas: toQuantity(report.gasLimit) },
      snapshot,
    ]),
  );
  assert.equal(await provider.getCode(proxy), beforeProxy);
  assert.equal(await provider.getCode(CODE_COPY), "0x");
  assert.equal(
    await rpc("eth_getStorageAt", [target, "0x0", snapshot]),
    beforeTarget,
  );
  assert.equal(
    await rpc("eth_getStorageAt", [proxy, "0x0", snapshot]),
    beforeExecutions,
  );
  // Broadcast only to the isolated local EVM to verify actual state effects.
  const signer = await provider.getSigner(0);
  const submitted = await signer.sendTransaction({
    to: proxy,
    data,
    gasLimit: report.gasLimit,
    gasPrice: 1000000000n,
  });
  const receipt = await submitted.wait();
  assert.equal(receipt?.status, 1);
  assert.equal(
    BigInt((await rpc("eth_getStorageAt", [proxy, "0x0", "latest"])) as string),
    1n,
  );
  assert.notEqual(
    await rpc("eth_getStorageAt", [target, "0x0", "latest"]),
    beforeTarget,
  );
  assert.equal(await provider.getCode(CODE_COPY), "0x");
});
test("guard rejects unauthorized keeper and permanent target failure", async () => {
  const accounts = (await rpc("eth_accounts", [])) as string[];
  await assert.rejects(
    estimateAction(rpc, policy, { data, mode: "estimate" }, accounts[1], {
      blockTag: snapshot,
      gasPrice: "1000000000",
    }),
  );
  const failed = ACTION_ABI.encodeFunctionData("executeAction", [
    target,
    2,
    [fail],
    [],
    "0x" + "00".repeat(32),
  ]);
  await assert.rejects(
    estimateAction(rpc, policy, { data: failed, mode: "estimate" }, sender, {
      blockTag: snapshot,
      gasPrice: "1000000000",
    }),
  );
});
