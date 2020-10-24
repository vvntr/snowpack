/**
 * Copy/paste from Snowpack utils, at least until there’s some common import
 */
const path = require('path');

/** determine if remote package or not */
exports.isRemoteModule = function isRemoteModule(specifier) {
  return (
    specifier.startsWith('//') ||
    specifier.startsWith('http://') ||
    specifier.startsWith('https://')
  );
};

/** URL relative */
exports.relativeURL = function relativeURL(path1, path2) {
  let url = path.relative(path1, path2).replace(/\\/g, '/');
  if (!url.startsWith('./') && !url.startsWith('../')) {
    url = './' + url;
  }
  return url;
};

/** Remove \ and / from beginning of string */
exports.removeLeadingSlash = function removeLeadingSlash(path) {
  return path.replace(/^[/\\]+/, '');
};
