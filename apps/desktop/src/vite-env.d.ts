/// <reference types="vite/client" />

/** 开发钩子：设置后启动即自动连接匹配的设备（serial 或设备 id）。不设置则不生效。 */
interface ImportMetaEnv {
  readonly VITE_GP_AUTOCONNECT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
