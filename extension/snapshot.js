/**
 * Development shim.
 *
 * The repository keeps exactly one implementation of the DOM semantics in `../src/snapshot.js`.
 * Loading the extension directly from this directory resolves that file through this re-export.
 * When the extension is packaged, `scripts/build-extension.js` bundles this module so the ZIP
 * contains a self-contained artifact that needs no files outside the extension root.
 *
 * This file is not copied into the packaged extension.
 */
export { projectSnapshot, projectElementFingerprint } from '../src/snapshot.js'
