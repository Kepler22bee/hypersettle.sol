// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {Messages} from "./libs/Messages.sol";
import {IWormhole} from "./interfaces/IWormhole.sol";

/// @title HyperSettleSpoke
/// @notice EVM spoke for HyperSettle: custodies tokens, forwards encrypted
/// deposit/invoice intents to the Solana hub via Wormhole, and executes
/// Ika-signed settlements back.
///
/// - `deposit` and `invoice` emit Wormhole VAAs. Spokes hold no authority
///   over outbound messages other than as the emitter-of-record.
/// - `executeSettlement` is the only path that moves tokens out. It requires
///   a valid ECDSA signature from the registered Ika dWallet address over
///   `Messages.settlementDigest(order)`.
/// - Per blueprint Mental Model 3, the spoke deals in plaintext tokens.
///   The hub deals in ciphertexts. They exchange ciphertext-pubkey handles.
contract HyperSettleSpoke is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Config ─────────────────────────────────────────────────────────

    /// @notice Wormhole chain id the hub is deployed on (Solana).
    uint16 public immutable hubChain;
    /// @notice HyperSettle internal domain id for this spoke.
    uint32 public immutable selfDomain;
    /// @notice Wormhole core bridge for this EVM chain.
    IWormhole public immutable wormhole;
    /// @notice Address of the registered Ika dWallet for this spoke. The only
    /// signer authorized to produce `SettlementOrder` signatures we honor.
    address public ikaDWallet;

    /// @notice Per-ticker ERC20 binding. Settlements specify `ticker` +
    /// `assetHash`; the spoke resolves which token to transfer via this map.
    mapping(bytes32 ticker => address token) public tickerToken;

    /// @notice Consumed settlement nonces per Ika dWallet. Replay protection.
    mapping(uint64 nonce => bool consumed) public consumedNonces;

    /// @notice Monotonic intent sequence for this spoke. Stamped into
    /// `intentId = keccak256(address(this), sequence)` so each message is
    /// uniquely addressable hub-side.
    uint64 public intentSequence;

    // ── Events ─────────────────────────────────────────────────────────

    event DepositPosted(
        bytes32 indexed intentId,
        address indexed user,
        address indexed token,
        uint256 amount,
        bytes32 amountCt,
        uint64 sequence
    );
    event InvoicePosted(
        bytes32 indexed intentId,
        address indexed user,
        bytes32 ticker,
        bytes32 amountCt,
        uint16 recipientChain,
        bytes32 recipient,
        uint64 sequence
    );
    event SettlementExecuted(
        bytes32 indexed intentId,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        uint64 nonce
    );
    event TickerBound(bytes32 indexed ticker, address indexed token);
    event IkaDWalletUpdated(address indexed oldDWallet, address indexed newDWallet);

    // ── Errors ─────────────────────────────────────────────────────────

    error UnboundTicker(bytes32 ticker);
    error DestinationMismatch(uint16 expected, uint16 got);
    error DomainMismatch(uint32 expected, uint32 got);
    error NonceAlreadyConsumed(uint64 nonce);
    error InvalidSignature();
    error ZeroAddress();
    error VersionUnsupported(uint8 got);

    // ── Constructor ────────────────────────────────────────────────────

    constructor(
        address owner_,
        uint16 hubChain_,
        uint32 selfDomain_,
        address wormhole_,
        address ikaDWallet_
    ) Ownable(owner_) {
        if (wormhole_ == address(0) || ikaDWallet_ == address(0)) revert ZeroAddress();
        hubChain = hubChain_;
        selfDomain = selfDomain_;
        wormhole = IWormhole(wormhole_);
        ikaDWallet = ikaDWallet_;
    }

    // ── Admin ──────────────────────────────────────────────────────────

    function bindTicker(bytes32 ticker, address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        tickerToken[ticker] = token;
        emit TickerBound(ticker, token);
    }

    function setIkaDWallet(address newDWallet) external onlyOwner {
        if (newDWallet == address(0)) revert ZeroAddress();
        emit IkaDWalletUpdated(ikaDWallet, newDWallet);
        ikaDWallet = newDWallet;
    }

    // ── Deposit ────────────────────────────────────────────────────────

    /// @notice Custody `amount` of `token` and forward an encrypted deposit
    /// intent to the hub. The caller must have approved `amount` to this
    /// contract.
    ///
    /// @param ticker canonical ticker hash (e.g., keccak256("USDC"))
    /// @param assetHash keccak256(chainId, tokenAddress) per blueprint MM9
    /// @param amount plaintext amount transferred into custody
    /// @param amountCt pubkey of the Encrypt ciphertext account holding the
    ///   encrypted `amount` (created off-chain via Encrypt gRPC)
    /// @param epoch current hub epoch (plaintext per MM1)
    function deposit(
        bytes32 ticker,
        bytes32 assetHash,
        uint256 amount,
        bytes32 amountCt,
        uint64 epoch
    ) external payable nonReentrant returns (bytes32 intentId, uint64 sequence) {
        address token = tickerToken[ticker];
        if (token == address(0)) revert UnboundTicker(ticker);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        uint64 seq = ++intentSequence;
        intentId = keccak256(abi.encodePacked(address(this), seq));

        Messages.DepositIntent memory intent = Messages.DepositIntent({
            version: Messages.INTENT_VERSION,
            sourceChain: _thisWormholeChain(),
            sourceDomain: selfDomain,
            ticker: ticker,
            assetHash: assetHash,
            epoch: epoch,
            amountCt: amountCt,
            intentId: intentId
        });

        sequence = wormhole.publishMessage{value: msg.value}(
            uint32(seq),
            Messages.packDepositIntent(intent),
            1 /*consistency level: finalized*/
        );

        emit DepositPosted(intentId, msg.sender, token, amount, amountCt, sequence);
    }

    // ── Invoice ────────────────────────────────────────────────────────

    /// @notice Forward an encrypted invoice intent to the hub. No tokens
    /// move here; payout happens on `executeSettlement` at the destination
    /// spoke.
    function invoice(
        bytes32 ticker,
        bytes32 amountCt,
        uint64 epoch,
        uint16 recipientChain,
        bytes32 recipient
    ) external payable nonReentrant returns (bytes32 intentId, uint64 sequence) {
        uint64 seq = ++intentSequence;
        intentId = keccak256(abi.encodePacked(address(this), seq));

        Messages.InvoiceIntent memory intent = Messages.InvoiceIntent({
            version: Messages.INTENT_VERSION,
            sourceChain: _thisWormholeChain(),
            sourceDomain: selfDomain,
            ticker: ticker,
            epoch: epoch,
            amountCt: amountCt,
            recipientChain: recipientChain,
            recipient: recipient,
            intentId: intentId
        });

        sequence = wormhole.publishMessage{value: msg.value}(
            uint32(seq),
            Messages.packInvoiceIntent(intent),
            1
        );

        emit InvoicePosted(
            intentId,
            msg.sender,
            ticker,
            amountCt,
            recipientChain,
            recipient,
            sequence
        );
    }

    // ── Settlement execution ───────────────────────────────────────────

    /// @notice Execute an Ika-signed settlement order: verify the ECDSA
    /// signature, enforce destination/version/nonce invariants, and
    /// transfer `order.amount` of the bound token to `order.recipient`.
    ///
    /// Anyone can call (it's a relayer action). Authorization lives in the
    /// signature check.
    function executeSettlement(
        Messages.SettlementOrder calldata order,
        bytes calldata signature
    ) external nonReentrant {
        if (order.version != Messages.INTENT_VERSION) revert VersionUnsupported(order.version);
        if (order.destChain != _thisWormholeChain()) {
            revert DestinationMismatch(_thisWormholeChain(), order.destChain);
        }
        if (order.destDomain != selfDomain) revert DomainMismatch(selfDomain, order.destDomain);
        if (consumedNonces[order.nonce]) revert NonceAlreadyConsumed(order.nonce);

        bytes32 digest = Messages.settlementDigest(order);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != ikaDWallet) revert InvalidSignature();

        consumedNonces[order.nonce] = true;

        address token = tickerToken[order.ticker];
        if (token == address(0)) revert UnboundTicker(order.ticker);

        address recipient = address(uint160(uint256(order.recipient)));
        if (recipient == address(0)) revert ZeroAddress();

        IERC20(token).safeTransfer(recipient, order.amount);

        emit SettlementExecuted(order.intentId, recipient, token, order.amount, order.nonce);
    }

    // ── Internal ───────────────────────────────────────────────────────

    /// @dev Wormhole chain id of the chain this contract is deployed to.
    /// Passed at deploy time implicitly via `block.chainid`-derived config
    /// in production; hard-wired here via a virtual for easy test override.
    function _thisWormholeChain() internal view virtual returns (uint16) {
        return _wormholeChainFromEvmChainId(block.chainid);
    }

    /// @dev Map EVM chain id to Wormhole chain id. Only the mainnets and
    /// testnets we care about. Unknown chains revert during execute to
    /// avoid misrouted settlements.
    function _wormholeChainFromEvmChainId(uint256 evmChainId) internal pure returns (uint16) {
        if (evmChainId == 8453) return 30;      // Base mainnet
        if (evmChainId == 84532) return 10004;  // Base Sepolia
        if (evmChainId == 42161) return 23;     // Arbitrum One
        if (evmChainId == 421614) return 10003; // Arbitrum Sepolia
        if (evmChainId == 1) return 2;          // Ethereum mainnet
        if (evmChainId == 11155111) return 10002; // Sepolia
        return 0;
    }
}
