import { createContext, useContext } from 'react';

export const DownloadContext = createContext(() => {});

export function useDownload() {
  return useContext(DownloadContext);
}
