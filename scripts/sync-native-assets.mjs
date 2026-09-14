#!/usr/bin/env node
/**
 * Kopiuje wstrzykiwane skrypty do zasobów natywnych (android/app/src/main/assets/inject).
 * Uruchamiane po `cap sync`, bo cap sync nadpisuje assets/public, a inject/ zostaje —
 * dzięki temu źródło prawdy jest jedno: apps/web/public/inject/.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'apps/web/public/inject');
const dst = join(root, 'android/app/src/main/assets/inject');

if (!existsSync(join(root, 'android'))) {
  console.log('· brak android/ — pomijam (uruchom najpierw: npx cap add android)');
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
let n = 0;
for (const file of readdirSync(src)) {
  if (!file.endsWith('.js')) continue;
  copyFileSync(join(src, file), join(dst, file));
  n++;
}
console.log(`✓ zsyncnowane pliki wstrzykiwane do WebView: ${n} → android/app/src/main/assets/inject`);
