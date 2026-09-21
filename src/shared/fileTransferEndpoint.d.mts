export class FileTransferFiles {
  constructor(root: string, options?: { confined?: boolean })
  call(action: Record<string, any>, authorize?: () => void): Promise<any>
  close(): Promise<void>
}
