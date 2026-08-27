/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

type FileSystemPermissionMode = 'read' | 'readwrite'

interface FileSystemHandle {
  queryPermission(options?: { mode?: FileSystemPermissionMode }): Promise<PermissionState>
  requestPermission(options?: { mode?: FileSystemPermissionMode }): Promise<PermissionState>
}

interface Window {
  showDirectoryPicker(options?: {
    id?: string
    mode?: FileSystemPermissionMode
    startIn?: FileSystemHandle | string
  }): Promise<FileSystemDirectoryHandle>
}
/// <reference types="vite-plugin-pwa/client" />

declare const __ARCGIS_SDK_VERSION__: string
