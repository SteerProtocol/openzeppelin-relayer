// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Deliberately models the inspected Steer execution boundaries: keeper caller,
// proxy storage, self-only inner call, caught failure and enum return. This is
// not the production contract; historical validation covers deployed bytecode.
contract FixtureProxy {
    constructor(address implementation) {
        assembly { sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, implementation) }
    }
    fallback() external payable {
        assembly {
            let implementation := sload(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
contract FixtureOrchestrator {
    address immutable keeper;
    uint256 public executions;
    constructor(address keeper_) { keeper = keeper_; }
    function executeAction(address target, uint256, bytes[] calldata calls, uint256[] calldata, bytes32) external returns (uint8) {
        require(msg.sender == keeper, "Not keeper");
        require(tx.origin == keeper, "Wrong origin");
        (bool ok,) = address(this).call{gas: 500000}(abi.encodeWithSignature("_executeAction(address,bytes[])", target, calls));
        if (ok) { executions++; return 1; }
        return 0;
    }
    function _executeAction(address target, bytes[] calldata calls) external {
        require(msg.sender == address(this), "Only self");
        for (uint256 i; i < calls.length; ++i) {
            (bool ok,) = target.call(calls[i]);
            require(ok);
        }
    }
}
contract FixtureTarget {
    bytes32 public result;
    function burn(uint256 loops) external {
        bytes32 v;
        for (uint256 i; i < loops; ++i) v = keccak256(abi.encode(v, i));
        result = v;
    }
    function fail() external pure { revert("Permanent target failure"); }
}
