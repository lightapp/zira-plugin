# Apache ECharts (vendored)

`echarts.min.js` is the unmodified `dist/echarts.min.js` from the npm package `echarts@6.1.0`
(Apache-2.0; see `LICENSE` and `NOTICE`). Readings reports inline it so they work offline under a
strict, hash-based Content Security Policy.

- npm integrity: `sha512-q0yaFPggC9FUdsWH4blavRWFmxdrIodbkoKNAjJudAI6CA9gNPxHtV2RcZNEepZVlk4yvBYkOkbk6HIVpIyHZA==`
- SHA-256 of `echarts.min.js`: `b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0`

Its only dynamic code is a GeoJSON fallback that reports do not use, so pages need no `unsafe-eval`.
To update: `npm pack echarts@<version>`, copy `package/dist/echarts.min.js`, `LICENSE` and `NOTICE`
here, update this file's version and hashes, and run the readings-report tests.
