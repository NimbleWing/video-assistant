import globals from 'globals';

// 正确性导向：专拦 ReferenceError（v1.7.0 P0 同类）、未用变量、不可达代码。
// 不含任何 stylistic 规则，避免大规模重排。
export default [
  {
    // server（TS 化后有独立工具链 tsc+vitest）、server-web 均有独立检查，不归本配置管
    ignores: ['server/**', 'server-web/**'],
  },
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        chrome: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-fallthrough': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      'no-useless-catch': 'error',
      'no-implied-eval': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'allow-null'],
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
