const fs = require('fs');
const path = require('path');
const glob = require('glob');
const colors = require('kleur/colors');
const {minify: minifyHtml} = require('html-minifier');
const {minify: minifyCss} = require('csso');
const esbuild = require('esbuild');
const {init} = require('es-module-lexer');
const PQueue = require('p-queue').default;
const {preloadJSAndCSS} = require('./lib/html');
const {concatAndMinifyCSS, hasCSSImport, embedStaticCSS} = require('./lib/css');

/**
 * Default optimizer for Snawpack, unless another one is given
 */
exports.default = function plugin(config, userDefinedOptions) {
  const options = {
    minifyJS: true,
    minifyHTML: true,
    minifyCSS: true,
    preloadModules: false,
    combinedCSSName: '/imported-styles.css',
    ...(userDefinedOptions || {}),
  };

  const CONCURRENT_WORKERS = require('os').cpus().length;

  async function optimizeFile({esbuildService, file, target, preloadCSS = false, rootDir}) {
    const baseExt = path.extname(file).toLowerCase();
    const result = {css: {}};

    // optimize based on extension. if it’s not here, leave as-is
    switch (baseExt) {
      case '.css': {
        if (options.minifyCSS) {
          let code = fs.readFileSync(file, 'utf-8');
          code = minifyCss(code).css;
          fs.writeFileSync(file, code, 'utf-8');
        }
        return result;
      }
      case '.js':
      case '.mjs': {
        let code;
        let isModified = false;

        // embed CSS
        if (preloadCSS) {
          if (!code) code = fs.readFileSync(file, 'utf-8'); // skip reading file if not necessary
          const embeddedCSS = embedStaticCSS(file, code);
          code = embeddedCSS.code; // update imports
          isModified = true;
          result.css = {...embeddedCSS.importList};
        }

        // minify if enabled
        if (options.minifyJS) {
          if (!code) code = fs.readFileSync(file, 'utf-8');
          const minified = await esbuildService.transform(code, {minify: true, target});
          code = minified.js;
          isModified = true;
        }

        if (isModified) fs.writeFileSync(file, code);
        return result;
      }
      case '.html': {
        if (!options.minifyHTML && !options.preloadModules) {
          break;
        }

        let code = fs.readFileSync(file, 'utf-8');
        if (options.preloadModules) {
          code = preloadJSAndCSS({
            code,
            rootDir,
            file,
            cssName: preloadCSS ? options.combinedCSSName : undefined,
          });
        }
        if (options.minifyHTML) {
          code = minifyHtml(code, {
            removeComments: true,
            collapseWhitespace: true,
          });
        }
        fs.writeFileSync(file, code, 'utf-8');
        return result;
      }
    }
  }

  return {
    name: '@snowpack/plugin-optimize',
    async optimize({buildDirectory}) {
      // 0. setup
      const esbuildService = await esbuild.startService();
      await init;
      let manifest = {css: {}};

      // 1. scan directory
      const allFiles = glob
        .sync('**/*', {
          cwd: buildDirectory,
          ignore: [`${config.buildOptions.metaDir}/*`, ...((options && options.exclude) || [])],
          nodir: true,
        })
        .map((file) => path.join(buildDirectory, file)); // resolve to root dir

      // 2. before parallel build, determine if CSS is being imported
      const preloadCSS = hasCSSImport(
        allFiles.filter((f) => path.extname(f) === '.js' || path.extname(f) === '.mjs'),
      );

      // 3. optimize all files in parallel
      const parallelWorkQueue = new PQueue({concurrency: CONCURRENT_WORKERS});
      for (const file of allFiles) {
        parallelWorkQueue.add(() =>
          optimizeFile({
            file,
            esbuildService,
            rootDir: buildDirectory,
            preloadCSS,
            target: options.target,
          })
            .then((result) => {
              manifest.css = {...manifest.css, ...result.css};
            })
            .catch((err) => {
              console.error(
                colors.dim('[@snowpack/plugin-optimize]') + `Error: ${file} ${err.toString()}`,
              );
            }),
        );
      }
      await parallelWorkQueue.onIdle();

      // 4. clean up esbuild
      esbuildService.stop();

      // 5. assemble manifest
      // TODO: resolve relative to project
      manifest.css = Object.fromEntries(Object.entries(manifest.css).map(([k, v]) => []));
      fs.writeFileSync(
        path.join(buildDirectory, config.buildOptions.metaDir, 'manifest.json'),
        JSON.stringify(manifest),
        'utf-8',
      );

      // 6. build CSS file (and delete unneeded CSS )
      // TODO: delete proxy files
      fs.writeFileSync(
        path.join(buildDirectory, 'all.css'),
        concatAndMinifyCSS(manifest.css),
        'utf-8',
      );
    },
  };
};
