/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_VOICE_GATEWAY_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
