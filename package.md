/*
    node-red-mcu-plugin by @ralphwetzel
    https://github.com/ralphwetzel/node-red-mcu-plugin
    License: MIT
*/

Comments on package.json

```json
  "dependencies": {
    "node-abort-controller": "^3.0.0" // node@14: Polyfill for AbortController
  },
 "engines": {
    "node": ">=14.17.0"     // to support AbortError @ exec & execFile
  }
```