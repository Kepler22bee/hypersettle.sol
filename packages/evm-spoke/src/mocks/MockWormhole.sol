// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {IWormhole} from "../interfaces/IWormhole.sol";

/// Demo-only Wormhole stand-in. Records the published payload and a
/// monotonically-increasing sequence so the spoke's deposit/invoice paths
/// don't revert on missing infrastructure.
contract MockWormhole is IWormhole {
    uint64 public nextSequence;
    bytes public lastPayload;
    uint32 public lastNonce;
    uint8 public lastConsistency;
    uint256 public feeOverride;

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistency)
        external
        payable
        returns (uint64 sequence)
    {
        require(msg.value >= feeOverride, "fee");
        lastNonce = nonce;
        lastPayload = payload;
        lastConsistency = consistency;
        sequence = ++nextSequence;
    }

    function messageFee() external view returns (uint256) {
        return feeOverride;
    }

    function setFee(uint256 f) external {
        feeOverride = f;
    }
}
