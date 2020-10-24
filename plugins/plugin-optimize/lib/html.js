/**
 * Logic for optimizing .html files (note: this will )
 */
const {parse} = require('es-module-lexer');
const {isRemoteModule, relativeURL, removeLeadingSlash} = require('../util');

// constants
const HTML_JS_REGEX = /<script[^>]+type="?module"?[^>]*>/gims;
const CLOSING_HEAD_TAG = /<\s*\/\s*head\s*>/gi;
const CLOSING_BODY_TAG = /<\s*\/\s*body\s*>/gi;

/** Append HTML before closing </head> tag */
function appendHTMLToHead(doc, htmlToAdd) {
  const closingHeadMatch = doc.match(CLOSING_HEAD_TAG);
  // if no <head> tag found, throw an error (we can’t load your app properly)
  if (!closingHeadMatch) {
    throw new Error(`No <head> tag found in HTML (this is needed to optimize your app):\n${doc}`);
  }
  // if multiple <head> tags found, also freak out
  if (closingHeadMatch.length > 1) {
    throw new Error(`Multiple <head> tags found in HTML (perhaps commented out?):\n${doc}`);
  }
  return doc.replace(closingHeadMatch[0], htmlToAdd + closingHeadMatch[0]);
}

/** Append HTML before closing </body> tag */
function appendHTMLToBody(doc, htmlToAdd) {
  const closingBodyMatch = doc.match(CLOSING_BODY_TAG);
  // if no <body> tag found, throw an error (we can’t load your app properly)
  if (!closingBodyMatch) {
    throw new Error(`No <body> tag found in HTML (this is needed to load your app):\n\n${doc}`);
  }
  // if multiple <body> tags found, also freak out
  if (closingBodyMatch.length > 1) {
    throw new Error(`Multiple <body> tags found in HTML (perhaps commented out?):\n\n${doc}`);
  }
  return doc.replace(closingBodyMatch[0], htmlToAdd + closingBodyMatch[0]);
}

/** Scan a JS file for static imports */
function scanForStaticImports({file, rootDir, scannedFiles, importList}) {
  try {
    // 1. scan file for static imports
    scannedFiles.add(file); // mark file as scanned
    importList.add(file); // also mark file as an import if it hasn’t been already
    let code = fs.readFileSync(file, 'utf-8');
    const [imports] = parse(code);
    imports
      .filter(({d}) => d === -1) // this is where we discard dynamic imports (> -1) and import.meta (-2)
      .forEach(({s, e}) => {
        const specifier = code.substring(s, e);
        importList.add(
          specifier.startsWith('/')
            ? path.join(rootDir, removeLeadingSlash(file))
            : path.resolve(path.dirname(file), specifier),
        );
      });

    // 2. recursively scan imports not yet scanned
    [...importList]
      .filter((fileLoc) => !scannedFiles.has(fileLoc)) // prevent infinite loop
      .forEach((fileLoc) => {
        scanForStaticImports({file: fileLoc, rootDir, scannedFiles, importList}).forEach(
          (newImport) => {
            importList.add(newImport);
          },
        );
      });

    return importList;
  } catch (err) {
    console.warn(
      colors.dim('[@snowpack/plugin-optimize]') +
        colors.yellow(` module preload failed: could not locate "${path.relative(rootDir, file)}"`),
    );
    return importList;
  }
}

/** Given a set of HTML files, trace the imported JS */
function preloadJSAndCSS({code, rootDir, htmlFile, cssName}) {
  const originalEntries = new Set(); // original entry files in HTML
  const allModules = new Set(); // all modules required by this HTML file

  const scriptMatches = code.match(new RegExp(HTML_JS_REGEX));
  if (!scriptMatches || !scriptMatches.length) return code; // if nothing matched, exit

  // 1. identify all entries in HTML
  scriptMatches
    .filter((script) => script.toLowerCase().includes('src')) // we only need to preload external "src" scripts; on-page scripts are already exposed
    .forEach((script) => {
      const scriptSrc = script.replace(/.*src="([^"]+).*/i, '$1');
      if (!scriptSrc || isRemoteModule(scriptSrc)) return; // if no src, or it’s remote, skip this tag
      const entry = scriptSrc.startsWith('/')
        ? path.join(rootDir, removeLeadingSlash(scriptSrc))
        : path.normalize(path.join(path.dirname(htmlFile), scriptSrc));
      originalEntries.add(entry);
    });

  // 2. scan entries for additional imports
  const scannedFiles = new Set(); // keep track of files scanned so we don’t get stuck in a circular dependency
  originalEntries.forEach((entry) => {
    scanForStaticImports({
      file: entry,
      rootDir,
      scannedFiles,
      importList: allModules,
    }).forEach((file) => allModules.add(file));
  });

  // 3. add CSS manifest (if applicable)
  if (cssName) {
    code = appendHTMLToHead(`    <link rel="stylesheet" href="${cssName}" />\n`);
  }

  // 4. add module preload to HTML (https://developers.google.com/web/updates/2017/12/modulepreload)
  const resolvedModules = [...allModules]
    .filter((m) => !originalEntries.has(m)) // don’t double-up preloading scripts that were already in the HTML
    .filter((m) => !m.endsWith('.css.proxy.js')) // don’t preload CSS proxy files (these will be removed)
    .map((src) => relativeURL(rootDir, src).replace(/^\./, ''));
  if (!resolvedModules.length) return code; // don’t add useless whitespace

  resolvedModules.sort((a, b) => a.localeCompare(b));
  code = appendHTMLToHead(
    code,
    `  <!-- @snowpack/plugin-optimize] Add modulepreload to improve unbundled load performance (More info: https://developers.google.com/web/updates/2017/12/modulepreload) -->\n` +
      resolvedModules.map((src) => `    <link rel="modulepreload" href="${src}" />`).join('\n') +
      '\n  ',
  );
  code = appendHTMLToBody(
    code,
    `  <!-- [@snowpack/plugin-optimize] modulepreload fallback for browsers that do not support it yet -->\n    ` +
      resolvedModules.map((src) => `<script type="module" src="${src}"></script>`).join('') +
      '\n  ',
  );

  // write file to disk
  return code;
}
exports.preloadJSAndCSS = preloadJSAndCSS;
