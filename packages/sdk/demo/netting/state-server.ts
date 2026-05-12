// Tiny HTTP server that exposes the live demo state for the frontend.
//
// The orchestrator owns the state object and mutates it as phases progress.
// The frontend at /netting polls GET /state every second.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type Phase =
  | "init"
  | "ika-dkg"
  | "boot"
  | "deposit-evm"
  | "deposit-sol"
  | "net"
  | "ika-sign-attempt"
  | "sign"
  | "unlock-evm"
  | "unlock-sol"
  | "done";

export interface DemoState {
  phase: Phase;
  startedAt: string;
  ika: {
    endpoint: string;
    dkgPubkey: string | null;
    dkgElapsedMs: number | null;
    signAttemptError: string | null;
  };
  env: {
    evm: {
      spokeAddr: string | null;
      usdcAddr: string | null;
      ikaAddress: string | null;
      chainId: number;
    };
    sol: {
      spokeProgram: string | null;
      mint: string | null;
      signingPubkey: string | null;
      ikaDkgPubkey: string | null;
    };
  };
  users: {
    userAEvm: string | null;
    userASolRecipient: string | null;
    userBSol: string | null;
    userBEvmRecipient: string | null;
  };
  deposits: {
    evm: { txHash: string; intentId: string; amountRaw: string } | null;
    sol: { txSig: string; amountRaw: string } | null;
  };
  net: {
    baseToSolRaw: string;
    solToBaseRaw: string;
    matchedRaw: string;
    surplusRaw: string;
    direction: "base→solana" | "solana→base" | "flat";
  } | null;
  signatures: {
    evmDigest: string | null;
    evmSig: string | null;
  };
  unlocks: {
    evm: { txHash: string; amountRaw: string } | null;
    sol: { txSig: string; amountRaw: string } | null;
  };
  balances: {
    userAOnSolRaw: string | null;
    userBOnEvmRaw: string | null;
    evmVaultRaw: string | null;
    solVaultRaw: string | null;
  };
  log: { ts: string; msg: string }[];
}

export function makeInitialState(ikaEndpoint: string, evmChainId: number): DemoState {
  return {
    phase: "init",
    startedAt: new Date().toISOString(),
    ika: {
      endpoint: ikaEndpoint,
      dkgPubkey: null,
      dkgElapsedMs: null,
      signAttemptError: null,
    },
    env: {
      evm: { spokeAddr: null, usdcAddr: null, ikaAddress: null, chainId: evmChainId },
      sol: { spokeProgram: null, mint: null, signingPubkey: null, ikaDkgPubkey: null },
    },
    users: {
      userAEvm: null,
      userASolRecipient: null,
      userBSol: null,
      userBEvmRecipient: null,
    },
    deposits: { evm: null, sol: null },
    net: null,
    signatures: { evmDigest: null, evmSig: null },
    unlocks: { evm: null, sol: null },
    balances: {
      userAOnSolRaw: null,
      userBOnEvmRaw: null,
      evmVaultRaw: null,
      solVaultRaw: null,
    },
    log: [],
  };
}

export class StateServer {
  private state: DemoState;
  private server: ReturnType<typeof createServer>;
  port: number;

  constructor(state: DemoState, port = 7070) {
    this.state = state;
    this.port = port;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, "127.0.0.1", () => resolve());
    });
  }

  stop() {
    this.server.close();
  }

  /** Mutate the state object directly; the next poll will pick it up. */
  patch(fn: (s: DemoState) => void) {
    fn(this.state);
  }

  log(msg: string) {
    this.state.log.push({ ts: new Date().toISOString(), msg });
    if (this.state.log.length > 100) this.state.log.shift();
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/state" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(this.state));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  }
}
