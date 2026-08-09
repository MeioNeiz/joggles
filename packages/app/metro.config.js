/**
 * Metro, taught about the workspace and about our `.js` import specifiers.
 *
 * Two things break without this, both silently and both costing a rebuild cycle to
 * diagnose on a handset:
 *
 *  1. `@joggles/core` lives outside this project's directory, so Metro neither watches
 *     it nor resolves it.
 *  2. That package is TypeScript source importing `./protocol.js`, the Node ESM
 *     convention. Metro does not remap that to `./protocol.ts`, so every internal
 *     import in core fails.
 */
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

// Try the TypeScript sources first for relative `.js` specifiers, and fall back so that
// dependencies which really do ship `.js` files still resolve.
//
// Both extensions, and that is not tidiness: `.ts` alone silently fails to resolve every
// component, because components are `.tsx`. The symptom is a blank screen rather than an
// error, since Fast Refresh keeps serving the last bundle that built.
const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    for (const ext of ['.ts', '.tsx']) {
      try {
        return resolve(context, moduleName.replace(/\.js$/, ext), platform)
      } catch {
        // Not this one. Try the next, then the specifier as written.
      }
    }
  }
  return resolve(context, moduleName, platform)
}

module.exports = config
