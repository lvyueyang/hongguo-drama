/// <reference types="vite/client" />
import type { RendererApi } from '@hongguo/contract';

declare global {
  interface Window {
    api: RendererApi;
  }
}
