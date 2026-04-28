// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/// @notice Minimal Wormhole Core interface consumed by the spoke.
///
/// Only the methods we actually call are declared here; the real Wormhole
/// interface is much larger. Phase 5 wires the real Wormhole Core + Relayer
/// addresses; Phase 3 treats this as an outbound-only dispatcher.
interface IWormhole {
    /// @notice Publish a message through the Wormhole core bridge.
    /// @return sequence Per-emitter monotonic sequence number.
    function publishMessage(
        uint32 nonce,
        bytes memory payload,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence);

    /// @notice Fee required to publish a message.
    function messageFee() external view returns (uint256);
}
