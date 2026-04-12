/**
 * Typed error classes for contract service operations.
 */

/** Base error for all contract service failures */
export class ContractError extends Error {
  constructor(
    message: string,
    public readonly contractName: string,
    public readonly functionName: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ContractError'
  }
}

/** Error from a read-only contract call (eth_call) */
export class ContractReadError extends ContractError {
  constructor(contractName: string, functionName: string, cause?: unknown) {
    super(
      `Failed to read ${contractName}.${functionName}()`,
      contractName,
      functionName,
      cause,
    )
    this.name = 'ContractReadError'
  }
}

/** Error from a state-changing user operation (includes encoding failures) */
export class UserOpError extends ContractError {
  constructor(
    contractName: string,
    functionName: string,
    public readonly txHash?: string,
    cause?: unknown,
  ) {
    super(
      `User operation failed: ${contractName}.${functionName}()`,
      contractName,
      functionName,
      cause,
    )
    this.name = 'UserOpError'
  }
}

/** Wallet not connected when attempting a contract call */
export class WalletNotConnectedError extends Error {
  constructor() {
    super('Wallet not connected')
    this.name = 'WalletNotConnectedError'
  }
}

/** Decrypt not yet available (coprocessor delay or poll timeout) */
export class DecryptPendingError extends Error {
  constructor(public readonly target: string) {
    super(`Decrypt result not yet available for ${target}`)
    this.name = 'DecryptPendingError'
  }
}
