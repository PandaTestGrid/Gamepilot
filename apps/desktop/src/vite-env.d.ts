/// <reference types="vite/client" />

/** 开发钩子：设置后启动即自动连接匹配的设备（serial 或设备 id）。不设置则不生效。 */
interface ImportMetaEnv {
  readonly VITE_GP_AUTOCONNECT?: string;
  /** 开发钩子：'1' 时启动即打开多开网格（验证多画面用） */
  readonly VITE_GP_GRID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
