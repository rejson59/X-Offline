#!/usr/bin/env node
/**
 * verify-android — bramka jakości dla projektu natywnego, której nie da się postawić
 * bez Android SDK: sprawdza to, co i tak wysypałoby Gradle/AAPT na samym początku,
 * plus rzeczy, które wysypałyby dopiero na telefonie (źle nazwany plugin, brakujący asset).
 *
 * Czego NIE robi: nie kompiluje Javę, nie łączy bibliotek, nie odpala aapt2.
 * Pełny build nadal tylko tam, gdzie jest JDK 21 + Android SDK (twoja maszyna albo CI).
 *
 * Wyjście: kod 0 = przeszło, 1 = błędy. Ostrzeżenia nie walą builda.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ANDROID = join(ROOT, 'android');
const APP = join(ANDROID, 'app');
const PKG_DIR = join(APP, 'src/main/java');
const RES = join(APP, 'src/main/res');
const ASSETS = join(APP, 'src/main/assets');

const errors = [];
const warnings = [];
const ok = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const pass = (msg) => ok.push(msg);

if (!existsSync(ANDROID)) {
  console.log('· nie ma katalogu android/ — pomijam (zbuduj go: npm run cap:add:android)');
  process.exit(0);
}

/* ------------------------------------------------------------------ utils */

const walk = (dir, filter = () => true) => {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
};

const read = (p) => readFileSync(p, 'utf8');
const rel = (p) => relative(ROOT, p).split('\\').join('/');

/** Usuwa komentarze i literały, żeby liczyć nawiasy i szukać kodu bez szumu. */
function stripCode(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | str | chr
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === '"') { mode = 'str'; out += ' '; i += 1; continue; }
      if (c === "'") { mode = 'chr'; out += ' '; i += 1; continue; }
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    // w stringu/znaku: liczymy się tylko z ucieczkami
    if (c === '\\') { i += 2; continue; }
    if ((mode === 'str' && c === '"') || (mode === 'chr' && c === "'")) mode = 'code';
    i += 1;
  }
  return out;
}

const balance = (src, open, close) => {
  let depth = 0;
  for (const ch of src) {
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
};

/** Minimalna kontrola XML: równowaga tagów + atrybuty w cudzysłowach. */
function checkXml(file, problems) {
  const src = read(file);
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"])*?)(\/?)>/g;
  let m;
  let seen = 0;
  while ((m = re.exec(src))) {
    seen++;
    const [, closing, name, attrs, selfClose] = m;
    const quotes = (attrs.match(/"/g) || []).length;
    if (quotes % 2 !== 0) problems.push(`${rel(file)}: nieparzysta liczba cudzysłowów w <${name}>`);
    if (closing) {
      const top = stack.pop();
      if (top !== name) problems.push(`${rel(file)}: zamknięcie </${name}> nie pasuje do <${top ?? 'brak'}>`);
    } else if (!selfClose) stack.push(name);
  }
  if (stack.length) problems.push(`${rel(file)}: niezamknięte tagi: ${stack.join(', ')}`);
  return src;
}

/* --------------------------------------------------------- 1. pliki javy */

const javaFiles = walk(PKG_DIR, (p) => p.endsWith('.java'));
if (!javaFiles.length) err('brak plików .java w android/app/src/main/java');

const xmlProblems = [];
const manifestFile = join(APP, 'src/main/AndroidManifest.xml');
const manifest = checkXml(manifestFile, xmlProblems);

const classNames = new Map(); // ProstaNazwa -> plik
for (const file of javaFiles) {
  const src = read(file);
  const code = stripCode(src);
  const name = rel(file).split('/').pop().replace(/\.java$/, '');
  classNames.set(name, file);

  const pkg = /package\s+([\w.]+);/.exec(code)?.[1];
  const dirPkg = rel(file)
    .split('/')
    .slice(rel(file).split('/').indexOf('java') + 1, -1)
    .join('.');
  if (!pkg) err(`${rel(file)}: brak deklaracji package`);
  else if (pkg !== dirPkg) err(`${rel(file)}: package "${pkg}" nie zgadza się z katalogiem "${dirPkg}"`);

  for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    if (!balance(code, open, close)) err(`${rel(file)}: niezbalansowane «${open}${close}»`);
  }

  if (/\bclass\s+\w+/.test(code) && !new RegExp(`(public|final|abstract)[\\s\\w]*class\\s+${name}\\b`).test(code)) {
    warn(`${rel(file)}: nazwa pliku (${name}.java) może nie pasować do nazwy klasy`);
  }

  // API Capacitora, które łatwo pomylić — wyłapane błędy z prawdziwego projektu
  if (/@CapacitorPlugin\s*\(/.test(code)) {
    const args = /@CapacitorPlugin\s*\(([^)]*)\)/.exec(code)?.[1] ?? '';
    if (/\bid\s*=/.test(args)) {
      err(`${rel(file)}: @CapacitorPlugin nie ma atrybutu „id” — użyj name = "..." (inaczej Gradle: cannot find symbol)`);
    }
  }
  if (/call\.getArray\(\s*"[^"]+"\s*,\s*new JSONArray\s*\(\s*\)\s*\)/.test(code)) {
    err(`${rel(file)}: PluginCall.getArray przyjmuje JSArray (nie JSONArray) — weź getArray("x") i sprawdź null`);
  }
  if (/getResources\(\)\.getIdentifier\s*\(/.test(code)) {
    warn(`${rel(file)}: getIdentifier() odpada przy minify — bezpieczniej R.*.`);
  }
  if (/android\.webkit\.webview\.WebView/.test(code)) {
    err(`${rel(file)}: import android.webkit.webview.WebView jest niepoprawny — android.webkit.WebView`);
  }
}

/* ----------------------------------------------- 2. zasoby wskazywane z manifestu */

const resDirs = existsSync(RES) ? readdirSync(RES) : [];
const resNames = new Map(); // "values/foo" -> nazwy, ale upraszczamy: typ -> Set(nazw)
for (const dir of resDirs) {
  const type = dir.split('-')[0];
  const set = resNames.get(type) ?? new Set();
  resNames.set(type, set);
  for (const file of walk(join(RES, dir))) {
    const base = file.split('/').pop().replace(/\.(xml|png|jpg|jpeg|webp|9\.png)$/, '');
    set.add(base);
    if (type === 'values') {
      const src = read(file);
      for (const m of src.matchAll(/<(string|color|dimen|style|bool|integer)\s+name="([^"]+)"/g)) {
        resNames.get(m[1])?.add(m[2]);
        (resNames.get(m[1]) ?? resNames.set(m[1], new Set()).get(m[1])).add(m[2]);
      }
    }
  }
}
for (const type of ['string', 'color', 'style', 'drawable', 'mipmap', 'xml', 'layout', 'dimen']) {
  if (!resNames.has(type)) resNames.set(type, new Set());
}

// zasoby z bibliotek (np. @color/colorPrimary żyje w @capacitor/android) — dozwolone
const libRes = new Map();
const capRes = join(ROOT, 'node_modules/@capacitor/android/capacitor/src/main/res');
if (existsSync(capRes)) {
  for (const dir of readdirSync(capRes)) {
    const type = dir.split('-')[0];
    for (const file of walk(join(capRes, dir))) {
      const set = libRes.get(type) ?? new Set();
      libRes.set(type, set);
      set.add(file.split('/').pop().replace(/\.xml$/, '').replace(/\.(png|jpg|webp)$/, ''));
      if (type === 'values') {
        for (const m of read(file).matchAll(/<(string|color|dimen|style|bool|integer)\s+name="([^"]+)"/g)) set.add(m[2]);
      }
    }
  }
}

const hasRes = (type, name) => resNames.get(type)?.has(name) || libRes.get(type)?.has(name) || false;

for (const [file, src] of [[manifestFile, manifest], ...walk(RES, (p) => p.endsWith('.xml')).map((f) => [f, read(f)])]) {
  for (const m of src.matchAll(/"@(\w+)\/([A-Za-z][\w.]*)"/g)) {
    const [, type, name] = m;
    if (!['string', 'color', 'style', 'drawable', 'mipmap', 'xml', 'layout', 'dimen'].includes(type)) continue;
    if (!hasRes(type, name)) err(`${rel(file)}: @${type}/${name} — nie ma takiego zasobu w app ani w @capacitor/android`);
  }
}
pass('każde @string/@style/@drawable/@color/@xml z plików XML rozwiązuje się do zasobu');

// aktywności w manifeście muszą istnieć jako klasy
for (const m of manifest.matchAll(/android:name="\.(\w+)"/g)) {
  if (!classNames.has(m[1])) err(`AndroidManifest.xml: .${m[1]} — brak pliku ${m[1]}.java`);
}
if (!/<uses-permission[^>]+android\.permission\.INTERNET/.test(manifest)) {
  err('AndroidManifest.xml: brak uprawnienia INTERNET (bez niego nie pobierzesz nic do offline)');
}

for (const file of walk(RES, (p) => p.endsWith('.xml'))) checkXml(file, xmlProblems);
for (const problem of xmlProblems) err(problem);
if (!xmlProblems.length) pass(`XML: manifest + ${walk(RES, (p) => p.endsWith('.xml')).length} plików res/ bez rozjechanych tagów`);

// nazwy pakietu w build.gradle muszą ić za appId
const config = read(join(ROOT, 'capacitor.config.ts'));
const appId = /appId:\s*'([^']+)'/.exec(config)?.[1];
const webDir = /webDir:\s*'([^']+)'/.exec(config)?.[1];
const appGradle = read(join(APP, 'build.gradle'));
for (const key of ['namespace', 'applicationId']) {
  const value = new RegExp(`${key}\\s+"([^"]+)"`).exec(appGradle)?.[1];
  if (!value) err(`app/build.gradle: brak ${key}`);
  else if (appId && value !== appId) err(`app/build.gradle: ${key}="${value}" ≠ appId z capacitor.config (${appId})`);
}
if (appId && manifest.includes('${applicationId}.fileprovider')) pass('FileProvider używa ${applicationId} — przeżyje zmianę appId');

/* ------------------------------------- 3. Gradle: pluginy powiązane z package.json */

const rootPkg = JSON.parse(read(join(ROOT, 'package.json')));
const capacitorDeps = Object.keys(rootPkg.dependencies ?? {}).filter((n) => n.startsWith('@capacitor/'));
const settings = read(join(ANDROID, 'capacitor.settings.gradle'));
const buildExtras = read(join(APP, 'capacitor.build.gradle'));

const linked = new Set([...settings.matchAll(/include ':capacitor-([\w-]+)'/g)].map((m) => `@capacitor/${m[1]}`));
const missingLink = capacitorDeps.filter((d) => d !== '@capacitor/core' && d !== '@capacitor/cli' && !linked.has(d));
if (missingLink.length) {
  err(`pluginy w package.json bez wpisu w android/capacitor.settings.gradle: ${missingLink.join(', ')} — odpal npm run cap:sync`);
} else pass(`wszystkie @capacitor/* z package.json podlinkowane w Gradle (${[...linked].length} modułów)`);

const declared = [...buildExtras.matchAll(/implementation project\('(:capacitor-[\w-]+)'\)/g)].map((m) => m[1]);
for (const need of linked) {
  const gradleName = `:capacitor-${need.replace('@capacitor/', '')}`;
  if (gradleName === ':capacitor-android') continue;
  if (!declared.includes(gradleName)) err(`app/capacitor.build.gradle: brakuje ${gradleName} (jest w settings.gradle) — odpal npm run cap:sync`);
}

for (const file of walk(ANDROID, (p) => p.endsWith('.gradle') || p.endsWith('.properties'))) {
  const src = stripCode(read(file).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  if (!balance(src, '{', '}')) err(`${rel(file)}: niezbalansowane klamry`);
}
if (webDir) {
  const built = existsSync(join(ROOT, webDir, 'index.html'));
  if (!built) warn(`brak ${webDir}/index.html — zanim cap sync zbuduj apkę (npm run build), w CI robi to krok „Build PWA”`);
  else pass(`webDir (${webDir}) ma index.html`);
}

/* --------------------------------- 4. assety wstrzykiwane do natywnego WebView */

for (const file of javaFiles) {
  const src = read(file);
  for (const m of src.matchAll(/"((?:inject|www|assets)\/[\w./-]+\.(?:js|css|json))"/g)) {
    const asset = join(ASSETS, m[1]);
    if (!existsSync(asset)) err(`${rel(file)}: getAssets().open("${m[1]}") — nie ma ${rel(asset)} (npm run native:sync?)`);
    else pass(`asset wstrzykiwany do WebView istnieje: ${m[1]}`);
  }
}
if (!existsSync(join(ASSETS, 'public/index.html'))) {
  warn('brak assets/public/index.html — to normalne przed `cap sync`, nie przed wrzuceniem APK na urządzenie');
}

/* ------------------------------ 5. kontrakt TS ↔ natywny plugin (nazwy i eventy) */

const bridgeFile = join(ROOT, 'apps/web/src/lib/bridge.ts');
const pluginFile = javaFiles.find((f) => f.endsWith('XLivePlugin.java'));
if (pluginFile && existsSync(bridgeFile)) {
  const java = read(pluginFile);
  const javaMethods = new Set([...java.matchAll(/@PluginMethod[\s\S]{0,120}?public\s+\w+\s+(\w+)\s*\(/g)].map((m) => m[1]));
  // eventy mogą lecieć z dowolnej klasy natywnej (mostek WebView też je wysyła)
  const javaEvents = new Set(
    javaFiles.flatMap((f) => [...read(f).matchAll(/(?:forward|notifyListeners)\(\s*"([A-Za-z]\w*)"/g)].map((m) => m[1])),
  );
  const ts = read(bridgeFile);
  const used = [...ts.matchAll(/p\.(\w+)\(/g)].map((m) => m[1]).filter((n) => n !== 'addListener');
  const listened = [...ts.matchAll(/addListener\('(\w+)'/g)].map((m) => m[1]);
  for (const method of used) {
    if (!javaMethods.has(method)) err(`bridge.ts woła XLive.${method}(), a XLivePlugin.java nie ma @PluginMethod ${method}`);
  }
  for (const event of listened) {
    if (!javaEvents.has(event)) err(`bridge.ts nasłuchuje '${event}', a Java nic takiego nie wysyła (forward("..."))`);
  }
  if (used.length && listened.length) pass(`kontrakt mostka: metody ${[...javaMethods].join('/')} + eventy ${[...javaEvents].join('/')}`);
}

/* ------------------- 5b. FileProvider a katalogi, do których zapisuje web (Directory.*) */

const filePaths = join(RES, 'xml', 'file_paths.xml');
// mapka jak w @capacitor/filesystem: LegacyFilesystemImplementation.getDirectory()
const DIR_ROOTS = {
  Documents: ['external'],
  ExternalStorage: ['external'],
  Data: ['files'],
  Library: ['files'],
  Cache: ['cache'],
  External: ['external-files', 'external'],
  ExternalCache: ['external-cache', 'external'],
};

if (!existsSync(filePaths)) {
  err('brak res/xml/file_paths.xml — FileProvider z manifestu wskazuje w pustkę, więc eksport/Share padnie');
} else {
  const pathsXml = read(filePaths);
  const declared = new Set([...pathsXml.matchAll(/<([\w-]+)-path\b[^>]*/g)].map((m) => m[1]));
  for (const m of pathsXml.matchAll(/<(\w+-path)([^>]*)>/g)) {
    if (!/path=/.test(m[2])) warn(`file_paths.xml: <${m[1]} bez atrybutu path="." — podkatalogi wypadną poza FileProvidera`);
  }
  const used = new Set();
  let sharesFiles = false;
  for (const f of walk(join(ROOT, 'apps/web/src'), (x) => /\.(ts|tsx)$/.test(x))) {
    const src = read(f);
    for (const m of src.matchAll(/Directory\.(\w+)/g)) used.add(m[1]);
    if (/Share\.share\(/.test(src)) sharesFiles = true;
  }
  for (const dir of used) {
    const acceptable = DIR_ROOTS[dir];
    if (!acceptable || acceptable.some((root) => declared.has(root))) continue;
    const what = `używamy Directory.${dir}, a file_paths.xml nie zna żadnego z: ${acceptable.map((r) => `<${r}-path>`).join(' / ')}`;
    if (sharesFiles) err(`${what} — Share dostanie URI spoza FileProvidera (IllegalArgumentException na telefonie)`);
    else warn(`${what} — plik będzie poza zasięgiem innych apek`);
  }
  if (used.size && sharesFiles) pass(`Directory.{${[...used].join(',')}} ma przykrycie w file_paths.xml (Share nie wybuchnie)`);
}

/* ------------------------------------------------------------- 6. wrapper gradle */

const wrapperProps = read(join(ANDROID, 'gradle/wrapper/gradle-wrapper.properties'));
const distUrl = /distributionUrl=(.*)/.exec(wrapperProps)?.[1] ?? '';
if (!/gradle-[5-9]\.\d+/.test(distUrl.replace(/\\/g, ''))) err(`gradle-wrapper: dziwny distributionUrl: ${distUrl}`);
else pass(`Gradle wrapper: ${distUrl.replace(/.*gradle-/, '').replace(/\.zip.*/, '')}`);
if (!existsSync(join(ANDROID, 'gradle/wrapper/gradle-wrapper.jar'))) err('brak gradle/wrapper/gradle-wrapper.jar — ./gradlew nie ruszy');

const vars = read(join(ANDROID, 'variables.gradle'));
const compileSdk = Number(/compileSdkVersion\s*=\s*(\d+)/.exec(vars)?.[1] ?? 0);
if (compileSdk < 34) err(`variables.gradle: compileSdkVersion ${compileSdk} — AGP 8 chce 34+`);
else pass(`compileSdk ${compileSdk}, minSdk ${/minSdkVersion\s*=\s*(\d+)/.exec(vars)?.[1]}`);

/* ---------------------------------------------------------------- report */

for (const line of ok) console.log(`✓ ${line}`);
for (const line of warnings) console.log(`! ${line}`);
for (const line of errors) console.log(`✗ ${line}`);
console.log(`\nverify-android: ${errors.length} błędów, ${warnings.length} ostrzeżeń.`);
if (errors.length) {
  console.log('To nie jest pełny build — tylko to, co da się sprawdzić bez Android SDK.');
  process.exit(1);
}
