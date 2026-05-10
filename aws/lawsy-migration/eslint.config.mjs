// Minimal ESLint v9+ flat config to satisfy `npm run lint`.
// PR#5 以前から package.json に lint script があるが config 不在で v10 が拒否していた問題への暫定対応。
// 本格的な lint ルール導入は別途検討 (cmd_454 hotfix のスコープ外)。
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {},
  },
  {
    ignores: ['cdk.out/**', 'dist/**', 'node_modules/**', '**/*.d.ts', '**/*.js'],
  },
];
