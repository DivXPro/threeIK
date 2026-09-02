// 下载 three.js 官方示例模型 Soldier.glb 到 playground/public/（该资产被 .gitignore 排除，不入库）
// 已存在则跳过；失败时非零退出并提示手动下载
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb';
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'Soldier.glb');

if (existsSync(dest)) {
  console.log(`Soldier.glb 已存在，跳过：${dest}`);
  process.exit(0);
}

console.log(`下载 Soldier.glb ← ${SOURCE_URL}`);
try {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`完成：${dest}（${(buf.length / 1024 / 1024).toFixed(2)} MB）`);
} catch (err) {
  console.error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
  console.error(`请手动下载 ${SOURCE_URL} 并保存为 playground/public/Soldier.glb`);
  process.exit(1);
}
