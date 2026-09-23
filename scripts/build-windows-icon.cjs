const { app, nativeImage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
app.whenReady().then(() => {
  const source = nativeImage.createFromBuffer(readFileSync(process.argv[2]))
  if (source.isEmpty()) throw new Error('应用图标无效')
  const sizes = [16, 32, 48, 256], images = sizes.map(size => source.resize({ width: size, height: size }).toPNG())
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  images.forEach((bytes, index) => {
    const at = 6 + index * 16
    header[at] = header[at + 1] = sizes[index] % 256
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(bytes.length, at + 8); header.writeUInt32LE(offset, at + 12)
    offset += bytes.length
  })
  writeFileSync(process.argv[3], Buffer.concat([header, ...images])); app.quit()
}).catch(error => { console.error(error.message); app.exit(1) })
