/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ZERODEV_BUNDLER_URL: string;
  readonly VITE_ZERODEV_PASSKEY_SERVER_URL: string;
  readonly VITE_RPC_URL: string;
  readonly VITE_API_BASE_URL: string;
  readonly VITE_CHAIN_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
