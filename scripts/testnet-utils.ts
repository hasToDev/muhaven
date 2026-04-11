/**
 * scripts/testnet-utils.ts
 *
 * Shared utilities for testnet test scripts.
 */

import { network } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

export interface DeployEntry {
  proxy?: string;
  implementation?: string;
  address?: string;
}

export interface Deployment {
  network: string;
  timestamp: string;
  deployer: string;
  contracts: Record<string, DeployEntry>;
}

export function loadDeployment(): Deployment {
  const net = network.name;
  const path = join(__dirname, "..", "deployments", `${net}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      `No deployment found at ${path}. Run 'pnpm run deploy:testnet' first.`,
    );
  }
}

export function getAddress(deployment: Deployment, name: string): string {
  const entry = deployment.contracts[name];
  if (!entry) throw new Error(`Contract '${name}' not found in deployment`);
  return entry.proxy ?? entry.address!;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
