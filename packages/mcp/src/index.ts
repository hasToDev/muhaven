/**
 * Public package surface.
 *
 * Consumers (Claude Desktop / Cursor / Claude Code) generally invoke
 * the binary `muhaven-mcp` (registered in `package.json` `bin`), which
 * calls `runMcpStdioCli()`.
 *
 * The named exports below let downstream code (tests, future
 * embeddings) reach the building blocks without spawning a subprocess.
 */

export {
  runMcpStdioCli,
  buildMcpServer,
  type RunMcpStdioCliOptions,
} from './server.js';
export {
  loadMcpConfig,
  loadBrokerConfig,
  defaultBrokerEndpoint,
  type McpRuntimeConfig,
  type BrokerRuntimeConfig,
} from './config.js';
export {
  TOOL_DESCRIPTORS,
  hashToolDescriptor,
  buildToolHashTable,
  verifyDescriptorAgainstPin,
  type ToolDescriptor,
  type ToolHashEntry,
} from './tools/descriptions.js';
export {
  fullToolRegistry,
  registryForReadOnly,
  selectRegistry,
  type ToolEntry,
} from './tools/registry.js';
export { BackendClient, BackendError, type BackendErrorCode } from './clients/backend-client.js';
export {
  BrokerClient,
  BrokerClientError,
  type BrokerClientErrorCode,
} from './clients/broker-client.js';
export { JwtSource, NoJwtAvailableError } from './auth/jwt-source.js';
export {
  DeviceFlowClient,
  DeviceFlowAbortedError,
  type DeviceFlowEvent,
} from './auth/device-flow.js';
export {
  BrokerDaemon,
  handleBrokerRequest,
  BROKER_PROTOCOL_VERSION,
  type BrokerDaemonOptions,
} from './broker/daemon.js';
export {
  parseBrokerRequest,
  serializeResponse,
  type BrokerRequest,
  type BrokerResponse,
} from './broker/protocol.js';
export {
  openKeystore,
  KeystoreError,
  type IKeystore,
  type KeystoreBackend,
} from './broker/keystore.js';
