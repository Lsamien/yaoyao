/** Limits apply to brokered file copies, independently of chat attachments. */
export const FILE_TRANSFER_DEFAULT_MIB = 25
export const FILE_TRANSFER_MAX_MIB = 100
export const FILE_TRANSFER_CHUNK_BYTES = 512 * 1024
export const FILE_TRANSFER_HARD_BYTES = FILE_TRANSFER_MAX_MIB * 1024 * 1024

export interface FileTransferEndpoint {
  name: string
  host: string
  path: string
  chunks: boolean
  call(action: Record<string, unknown>): Promise<any>
}
