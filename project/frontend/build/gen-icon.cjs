const sharp = require("sharp")
const mod = require("png-to-ico")
const pngToIco = mod.default || mod
const fs = require("fs")
const path = require("path")
const svgBig = fs.readFileSync(path.join(__dirname, "..", "public", "orqon.svg"))
const svgSmall = fs.readFileSync(path.join(__dirname, "orqon-small.svg"))
const out = path.join(__dirname, "..", "build")
async function main() {
  const buffers = []
  // Small sizes: use the simplified crisp mark. Large: full neon logo.
  for (const s of [16, 24, 32]) buffers.push(await sharp(svgSmall, { density: s*8 }).resize(s, s).png().toBuffer())
  for (const s of [48, 64, 128, 256]) buffers.push(await sharp(svgBig, { density: Math.max(384, s*4) }).resize(s, s).png().toBuffer())
  const ico = await pngToIco(buffers)
  fs.writeFileSync(path.join(out, "icon.ico"), ico)
  await sharp(svgBig, { density: 768 }).resize(512, 512).png().toFile(path.join(out, "icon.png"))
  console.log("wrote icon.ico =", ico.length, "bytes")
}
main().catch(e => { console.error(e.message); process.exit(1) })
