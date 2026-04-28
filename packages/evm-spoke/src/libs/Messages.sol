// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/// @notice Canonical message payloads carried between the hub and EVM spokes.
///
/// Cross-chain wire format is **big-endian packed bytes** (see
/// `packages/shared/messages.md`). This file defines both the Solidity
/// structs (used for in-contract convenience) and pack helpers that produce
/// the canonical byte layout the Solana hub parses.
///
/// Borsh and Solidity ABI both exist but don't interop; a hand-packed
/// big-endian format is the only neutral option both sides implement
/// cheaply.
library Messages {
    uint8 internal constant INTENT_VERSION = 1;

    struct DepositIntent {
        uint8 version;
        uint16 sourceChain;
        uint32 sourceDomain;
        bytes32 ticker;
        bytes32 assetHash;
        uint64 epoch;
        /// Pubkey of the Encrypt ciphertext account holding the encrypted amount.
        bytes32 amountCt;
        bytes32 intentId;
    }

    struct InvoiceIntent {
        uint8 version;
        uint16 sourceChain;
        uint32 sourceDomain;
        bytes32 ticker;
        uint64 epoch;
        bytes32 amountCt;
        uint16 recipientChain;
        bytes32 recipient;
        bytes32 intentId;
    }

    /// The only plaintext-amount message in the protocol. Produced by the hub
    /// after `reveal_settlement` and carried to the destination spoke with an
    /// Ika dWallet signature over `settlementDigest(order)`.
    struct SettlementOrder {
        uint8 version;
        uint16 sourceChain;
        uint16 destChain;
        uint32 destDomain;
        bytes32 ticker;
        bytes32 assetHash;
        uint64 amount;
        bytes32 recipient;
        bytes32 intentId;
        uint64 nonce;
    }

    /// @notice Compute the 32-byte digest the Ika dWallet signs for a
    /// `SettlementOrder`. Uses EIP-191 prefix so the off-chain Ika flow can
    /// sign it without custom tooling.
    function settlementDigest(SettlementOrder memory order) internal pure returns (bytes32) {
        bytes32 inner = keccak256(packSettlementOrder(order));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    // ── Packed (cross-chain wire) encoders ─────────────────────────────

    function packDepositIntent(DepositIntent memory i) internal pure returns (bytes memory) {
        return abi.encodePacked(
            i.version,
            i.sourceChain,
            i.sourceDomain,
            i.ticker,
            i.assetHash,
            i.epoch,
            i.amountCt,
            i.intentId
        );
    }

    function packInvoiceIntent(InvoiceIntent memory i) internal pure returns (bytes memory) {
        return abi.encodePacked(
            i.version,
            i.sourceChain,
            i.sourceDomain,
            i.ticker,
            i.epoch,
            i.amountCt,
            i.recipientChain,
            i.recipient,
            i.intentId
        );
    }

    function packSettlementOrder(SettlementOrder memory o) internal pure returns (bytes memory) {
        return abi.encodePacked(
            o.version,
            o.sourceChain,
            o.destChain,
            o.destDomain,
            o.ticker,
            o.assetHash,
            o.amount,
            o.recipient,
            o.intentId,
            o.nonce
        );
    }
}
