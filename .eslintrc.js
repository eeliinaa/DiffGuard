module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'no-transport-bypass-imports'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    'no-transport-bypass-imports/no-transport-bypass-imports': 'error',
  },
  overrides: [
    {
      files: ['src/transport/internal/*', 'src/transport/adapter.ts', 'src/transport/legacyTransport.ts'],
      rules: {
        'no-transport-bypass-imports/no-transport-bypass-imports': 'off',
      },
    },
  ],
};
