module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: 'module',
  },
  extends: ['eslint:recommended', 'prettier'],
  env: {
    es6: true,
    node: true,
  },
  rules: {
    camelcase: ['error', { properties: 'never' }],
    eqeqeq: 'error',
    'no-console': 'off',
    'no-useless-rename': 'error',
    'object-shorthand': ['error', 'always'],
    'prefer-destructuring': 'error',
    'prefer-template': 'error',
  },
  overrides: [
    {
      files: ['test/**/*.js'],
      env: {
        mocha: true,
      },
    },
  ],
};
