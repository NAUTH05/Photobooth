/**
 * Derives every brand asset the booth and the website need from the artwork in `icon/`.
 *
 *   node scripts/make-brand-assets.mjs
 *
 * `icon/logo.png` is the master (2000×2000, transparent around the pink badge); the
 * favicon set beside it comes from the designer and is copied through untouched. Rerun
 * this after replacing either, then commit what it writes — nothing here runs at build
 * time, so the repo always holds the exact bytes that ship.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "icon");
const at = (...parts) => path.join(root, ...parts);

/** A square PNG of the master logo, alpha kept so the badge stays round on any ground. */
const square = (size) => sharp(at("icon", "logo.png"))
  .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toBuffer();

/**
 * Windows .ico, PNG-compressed entries (Vista and newer). electron-builder wants a
 * 256×256 inside; the smaller entries are what the taskbar and Explorer actually pick.
 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, data }, index) => {
    const entry = index * 16;
    // 256 is stored as 0 — the byte only reaches 255.
    directory[entry] = size >= 256 ? 0 : size;
    directory[entry + 1] = size >= 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

/** 1200×630 social card: the badge on the site's own pink, no text to mis-render. */
async function socialCard() {
  const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FADCE6"/><stop offset="1" stop-color="#FFF8FA"/>
    </linearGradient></defs>
    <rect width="1200" height="630" fill="url(#sky)"/>
    <circle cx="112" cy="104" r="18" fill="#E891AA" opacity=".45"/>
    <circle cx="1094" cy="540" r="26" fill="#E891AA" opacity=".35"/>
    <circle cx="1048" cy="118" r="12" fill="#8ECFB8" opacity=".55"/>
    <circle cx="150" cy="522" r="13" fill="#F5D88A" opacity=".75"/>
  </svg>`);
  const badge = await square(430);
  return sharp(background)
    .composite([{ input: badge, top: 100, left: 385 }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const copies = [
  // The website serves the designer's favicon set as-is.
  ["favicon.ico", at("web", "public", "favicon.ico")],
  ["favicon-16x16.png", at("web", "public", "favicon-16x16.png")],
  ["favicon-32x32.png", at("web", "public", "favicon-32x32.png")],
  ["apple-touch-icon.png", at("web", "public", "apple-touch-icon.png")],
  ["android-chrome-192x192.png", at("web", "public", "android-chrome-192x192.png")],
  ["android-chrome-512x512.png", at("web", "public", "android-chrome-512x512.png")],
];

// Rendered sizes, each roughly 4× its on-screen box so it stays crisp on hidpi screens.
const renders = [
  [512, at("web", "public", "logo.png")],       // website wordmark + manifest fallback
  [256, at("src", "renderer", "logo.png")],     // booth window: 48px brand mark + favicon
];

await mkdir(at("web", "public"), { recursive: true });

for (const [name, destination] of copies) {
  await copyFile(path.join(source, name), destination);
  console.log(`copied  ${path.relative(root, destination)}`);
}

for (const [size, destination] of renders) {
  await writeFile(destination, await square(size));
  console.log(`resized ${path.relative(root, destination)} (${size}px)`);
}

const appIcon = at("icon", "app-icon.ico");
await writeFile(appIcon, ico(await Promise.all(
  [16, 24, 32, 48, 64, 128, 256].map(async (size) => ({ size, data: await square(size) })),
)));
console.log(`built   ${path.relative(root, appIcon)} (16→256)`);

const social = at("web", "public", "og-pink.png");
await writeFile(social, await socialCard());
console.log(`built   ${path.relative(root, social)} (1200×630)`);
