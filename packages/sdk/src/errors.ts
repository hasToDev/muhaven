export class MuHavenError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'MuHavenError'
  }
}

export class ConfigError extends MuHavenError {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export class NetworkError extends MuHavenError {
  constructor(expectedChainId: number, actualChainId: number) {
    super(`Chain mismatch: expected ${expectedChainId}, got ${actualChainId}`)
    this.name = 'NetworkError'
  }
}

export class EscrowNotFoundError extends MuHavenError {
  constructor(public readonly escrowId: bigint) {
    super(`Escrow ${escrowId} does not exist`)
    this.name = 'EscrowNotFoundError'
  }
}

export class EncryptionError extends MuHavenError {
  constructor(message: string, cause?: unknown) {
    super(`Encryption failed: ${message}`, cause)
    this.name = 'EncryptionError'
  }
}

export class BatchSizeExceededError extends MuHavenError {
  constructor(public readonly requested: number, public readonly max: number) {
    super(`Batch size ${requested} exceeds max ${max}`)
    this.name = 'BatchSizeExceededError'
  }
}

export class DistributionNotStartedError extends MuHavenError {
  constructor(public readonly distributionId: bigint) {
    super(`Distribution ${distributionId} has not been started`)
    this.name = 'DistributionNotStartedError'
  }
}

export class DistributionAlreadyCompleteError extends MuHavenError {
  constructor(public readonly distributionId: bigint) {
    super(`Distribution ${distributionId} is already complete`)
    this.name = 'DistributionAlreadyCompleteError'
  }
}

export class EscrowIdsAlreadySetError extends MuHavenError {
  constructor(public readonly distributionId: bigint) {
    super(`Escrow IDs already set for distribution ${distributionId}`)
    this.name = 'EscrowIdsAlreadySetError'
  }
}

export class TxFailedError extends MuHavenError {
  /**
   * @param operation  Human-readable label for the failing call
   *                   (e.g. 'MuHavenEscrow.batchCreate').
   * @param txHash     Transaction hash if the tx was broadcast; undefined if
   *                   the failure happened before submission (encoding,
   *                   insufficient funds, rejected by wallet). Consumers
   *                   should check for `undefined` rather than a literal '0x'.
   */
  constructor(
    public readonly operation: string,
    public readonly txHash: `0x${string}` | undefined,
    cause?: unknown,
  ) {
    super(
      txHash
        ? `Transaction failed for ${operation} (${txHash})`
        : `Transaction failed for ${operation} (not submitted)`,
      cause,
    )
    this.name = 'TxFailedError'
  }
}

/**
 * An invariant the SDK relies on was violated by the chain (event count
 * mismatch, unexpected return shape, etc.). Indicates either an ABI drift or
 * a contract change the SDK hasn't been updated for.
 */
export class InvariantError extends MuHavenError {
  constructor(message: string, cause?: unknown) {
    super(`Invariant violated: ${message}`, cause)
    this.name = 'InvariantError'
  }
}
