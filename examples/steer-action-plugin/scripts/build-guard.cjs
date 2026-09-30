const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(
  path.join(root, "contracts/ActionSimulationGuard.sol"),
  "utf8",
);
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "ActionSimulationGuard.sol": { content: source } },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "paris",
        metadata: { bytecodeHash: "none", appendCBOR: false },
        outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } },
      },
    }),
  ),
);
const errors = (output.errors || []).filter((e) => e.severity === "error");
if (errors.length)
  throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
const artifact =
  JSON.stringify(
    {
      compiler: solc.version(),
      evmVersion: "paris",
      runtime:
        "0x" +
        output.contracts["ActionSimulationGuard.sol"].ActionSimulationGuard.evm
          .deployedBytecode.object,
    },
    null,
    2,
  ) + "\n";
const destination = path.join(root, "guard-runtime.json");
if (process.argv.includes("--check")) {
  if (fs.readFileSync(destination, "utf8") !== artifact)
    throw new Error(
      "Guard runtime differs from source; run npm run build:guard",
    );
} else fs.writeFileSync(destination, artifact);
