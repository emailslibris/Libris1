const fs = require('fs')
const path = require('path')

const root = __dirname
const output = path.join(root, 'dist')
const publicFiles = [
  'index.html',
  'styles.css',
  'script.js',
  'local-store.mjs',
  'local-data.mjs',
  'firebase.js',
  'Librissf.png',
  'manifest.webmanifest',
  'sw.js',
  'icons/libris-192.png',
  'icons/libris-512.png'
]

fs.mkdirSync(output, { recursive: true })

for (const filename of publicFiles) {
  const source = path.join(root, filename)
  const destination = path.join(output, filename)
  if (!fs.existsSync(source)) {
    throw new Error(`Arquivo necessário para publicação não encontrado: ${filename}`)
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

console.log(`Build do Hosting pronto: ${publicFiles.length} arquivos em dist/.`)
