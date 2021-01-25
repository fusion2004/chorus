module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: 'module'
  },
  extends: [
    'eslint:recommended'
  ],
  env: {
    es6: true,
    node: true
  },
  rules: {
    'no-console': 'off',
    'no-constant-condition': [
      'error',
      { checkLoops: false }
    ],
    'array-bracket-spacing': ['error', 'never'],
    'arrow-parens': ['error', 'always'],
    'brace-style': ['error', '1tbs', { 'allowSingleLine': false }],
    'camelcase': ['error', { 'properties': 'always' }],
    'comma-dangle': ['error', 'never'],
    'comma-spacing': ['error', {
      'before': false,
      'after': true
    }],
    'comma-style': ['error', 'last'],
    'curly': ['error', 'all'],
    'dot-notation': 'error',
    'dot-location': ['error', 'property'],
    'indent': ['error', 2, { 'SwitchCase': 1 }],
    'key-spacing': ['error', {
      'beforeColon': false,
      'afterColon': true
    }],
    'keyword-spacing': ['error', {
      'overrides': {
        'catch': {
          'after': false
        }
      }
    }],
    'max-statements-per-line': ['error', { 'max': 1 }],
    'new-cap': ['error'],
    'no-empty': ['error'],
    'no-multiple-empty-lines': ['error', { 'max': 1 }],
    'func-call-spacing': 'error',
    'no-trailing-spaces': 'error',
    'no-useless-concat': 'error',
    'object-curly-spacing': ['error', 'always'],
    'one-var': ['error', {
      'uninitialized': 'always',
      'initialized': 'never'
    }],
    'operator-linebreak': ['error', 'before'],
    'quotes': ['error', 'single', { 'avoidEscape': true }],
    'semi': ['error', 'always'],
    'semi-spacing': ['error', {
      'before': false,
      'after': true
    }],
    'space-before-blocks': ['error', 'always'],
    'space-before-function-paren': ['error', 'never'],
    'space-in-parens': ['error', 'never'],
    'space-infix-ops': 'error',
    'space-unary-ops': ['error', {
      'words': false,
      'nonwords': false
    }],
    'spaced-comment': ['error', 'always'],
    'generator-star-spacing': ['error', {
      'before': false,
      'after': true
    }],
    'no-var': 'error',
    'no-useless-rename': 'error',
    'object-shorthand': ['error', 'always'],
    'prefer-destructuring': 'error',
    'prefer-spread': 'error',
    'prefer-template': 'error',
    'eol-last': ['error', 'always']
  },
  overrides: [
    {
      files: ['test/**/*.js'],
      env: {
        mocha: true
      }
    }
  ]
};
