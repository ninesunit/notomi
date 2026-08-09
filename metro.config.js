const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// pdfjs-dist ships `.mjs` worker/build entrypoints.
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'mjs', 'cjs'])];

module.exports = withNativeWind(config, { input: './global.css' });
