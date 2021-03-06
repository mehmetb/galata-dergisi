module.exports = {
  env: {
    browser: true,
    commonjs: true,
    es6: true,
    node: true,
  },
  extends: [
    'airbnb-base',
  ],
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly',
  },
  parserOptions: {
    ecmaVersion: 2018,
  },
  rules: {
    "no-console": ["off"],
    "no-restricted-syntax": ["off"],
    "max-len": ["error", { code: 140 }],
    "no-param-reassign": ["off"],
    "no-await-in-loop": ["off"],
    "object-curly-spacing": ["error", "always", { objectsInObjects: false, arraysInObjects: true }],
    "class-methods-use-this": ["warn"],
    "no-bitwise": ["warn"],
    "linebreak-style": "off",
    "no-plusplus": ["error", { allowForLoopAfterthoughts: true }],
    "import/extensions":["error", "ignorePackages"],
  },
};
