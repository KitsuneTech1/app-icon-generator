// One-off: resize a source image into Kitsune Music's Android launcher icons.
const sharp = require("sharp");
const fs = require("fs");

const src = process.argv[2] || "~/Downloads/source.png";
const base = process.argv[3] || "~/project/android/app/src/main/res";
const sizes = {
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};

(async () => {
  const meta = await sharp(src).metadata();
  console.log(`source ${src} - ${meta.width}x${meta.height} ${meta.format}`);
  for (const [dir, size] of Object.entries(sizes)) {
    const out = `${base}/${dir}/ic_launcher.png`;
    if (!fs.existsSync(`${base}/${dir}`)) fs.mkdirSync(`${base}/${dir}`, { recursive: true });
    await sharp(src).resize(size, size, { fit: "cover" }).png().toFile(out);
    console.log(`wrote ${dir}/ic_launcher.png (${size}px)`);
  }
  console.log("done");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
