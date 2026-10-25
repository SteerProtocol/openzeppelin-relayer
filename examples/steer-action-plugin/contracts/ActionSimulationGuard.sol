// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Only for RPC state overrides. Never install in a live proxy.
/// @dev No storage writes. ORIGINAL_PROXY_CODE is populated only in simulation.
contract ActionSimulationGuard {
    address internal constant ORIGINAL_PROXY_CODE = 0x00000000000000000000000000000000Ac710001;
    bytes4 internal constant EXECUTE_ACTION =
        bytes4(keccak256("executeAction(address,uint256,bytes[],uint256[],bytes32)"));

    error ActionNotCompleted();

    fallback() external payable {
        (bool ok, bytes memory result) = ORIGINAL_PROXY_CODE.delegatecall(msg.data);
        if (!ok) {
            assembly { revert(add(result, 32), mload(result)) }
        }
        if (msg.sig == EXECUTE_ACTION) {
            if (result.length != 32 || abi.decode(result, (uint256)) != 1) {
                revert ActionNotCompleted();
            }
        }
        assembly { return(add(result, 32), mload(result)) }
    }
}
